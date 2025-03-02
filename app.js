"use strict";
require('newrelic');
const base64id = require("base64id");

// Reads the SSL key and certificate, if there's no file available, we switch to regular http
var SyncRequest = require("sync-request");
var ServerKey = null;
if ((process.env.SERVER_KEY0 != null) && (process.env.SERVER_KEY0 != "")) { try { ServerKey = SyncRequest("GET", process.env.SERVER_KEY0).getBody(); } catch(err) {} }
if ((ServerKey == null) && (process.env.SERVER_KEY1 != null) && (process.env.SERVER_KEY1 != "")) { try { ServerKey = SyncRequest("GET", process.env.SERVER_KEY1).getBody(); } catch(err) {} }
if ((ServerKey == null) && (process.env.SERVER_KEY2 != null) && (process.env.SERVER_KEY2 != "")) { try { ServerKey = SyncRequest("GET", process.env.SERVER_KEY2).getBody(); } catch(err) {} }
var ServerCert = null;
if ((process.env.SERVER_CERT0 != null) && (process.env.SERVER_CERT0 != "")) { try { ServerCert = SyncRequest("GET", process.env.SERVER_CERT0).getBody(); } catch(err) {} }
if ((ServerCert == null) && (process.env.SERVER_CERT1 != null) && (process.env.SERVER_CERT1 != "")) { try { ServerCert = SyncRequest("GET", process.env.SERVER_CERT1).getBody(); } catch(err) {} }
if ((ServerCert == null) && (process.env.SERVER_CERT2 != null) && (process.env.SERVER_CERT2 != "")) { try { ServerCert = SyncRequest("GET", process.env.SERVER_CERT2).getBody(); } catch(err) {} }
console.log("Using Server Key: " + ServerKey);
console.log("Using Server Certificate: " + ServerCert);

// Enforce https with a certificate
var App;
var UseSecure;
if ((ServerKey == null) || (ServerCert == null)) {
	console.log("No key or certificate found, starting http server with origin " + process.env.CORS_ORIGIN0);
	UseSecure = false;
	App = require("http").createServer();
} else {
	console.log("Starting https server for certificate with origin " + process.env.CORS_ORIGIN0);
	UseSecure = true;
	App = require("https").createServer({ key: ServerKey, cert: ServerCert, requestCert: false, rejectUnauthorized: false });
}

// Starts socket.io to accept incoming connections on specified origins
const socketio = require("socket.io");
var Options = {
	maxHttpBufferSize: 180000,
	pingTimeout: 30000,
	pingInterval: 50000,
	upgradeTimeout: 30000,
	serveClient: false,
	httpCompression: true,
	perMessageDeflate: true,
	allowEIO3: false,
	secure: UseSecure
};
if ((process.env.CORS_ORIGIN0 != null) && (process.env.CORS_ORIGIN0 != ""))
	Options.cors = { origin: [process.env.CORS_ORIGIN0 || "", process.env.CORS_ORIGIN1 || "", process.env.CORS_ORIGIN2 || "", process.env.CORS_ORIGIN3 || "", process.env.CORS_ORIGIN4 || "", process.env.CORS_ORIGIN5 || ""] };
else
	Options.cors = { origin: '*' };
var IO = new socketio.Server(App, Options);

// Main game objects
var BCrypt = require("bcrypt");
var AccountCollection = process.env.ACCOUNT_COLLECTION || "Accounts";
var Account = [];
var ChatRoom = [];
var ChatRoomMessageType = ["Chat", "Action", "Activity", "Emote", "Whisper", "Hidden", "Status"];
var ChatRoomProduction = [
	process.env.PRODUCTION0 || "",
	process.env.PRODUCTION1 || "",
	process.env.PRODUCTION2 || "",
	process.env.PRODUCTION3 || "",
	process.env.PRODUCTION4 || "",
	process.env.PRODUCTION5 || "",
	process.env.PRODUCTION6 || "",
	process.env.PRODUCTION7 || "",
	process.env.PRODUCTION8 || "",
	process.env.PRODUCTION9 || ""
];
var NextMemberNumber = 1;
var NextPasswordReset = 0;
var OwnershipDelay = 604800000; // 7 days delay for ownership events
var LovershipDelay = 604800000; // 7 days delay for lovership events
var DifficultyDelay = 604800000; // 7 days to activate the higher difficulty tiers
const IP_CONNECTION_LIMIT = 64; // Limit of connections per IP address
const IP_CONNECTION_PROXY_HEADER = "x-forwarded-for"; // Header with real IP, if set by trusted proxy (lowercase)
const IP_CONNECTION_RATE_LIMIT = 2; // Limit of newly established connections per IP address within a second
const CLIENT_MESSAGE_RATE_LIMIT = 20; // Limit the number of messages received from a client within a second

// DB Access
var Database;
var DatabaseClient = require('mongodb').MongoClient;
var DatabaseURL = process.env.DATABASE_URL || "mongodb://localhost:27017/BondageClubDatabase";
var DatabasePort = process.env.PORT || 4288;
var DatabaseName = process.env.DATABASE_NAME || "BondageClubDatabase";

// Email password reset
var PasswordResetProgress = [];
var NodeMailer = require("nodemailer");
var MailTransporter = NodeMailer.createTransport({
	host: "mail.bondageprojects.com",
	Port: 465,
	secure: true,
	auth: {
		user: "donotreply@bondageprojects.com",
		pass: process.env.EMAIL_PASSWORD || ""
	}
});

// If the server received an unhandled error, we log it through console for future review, send an email and exit so the application can restart
process.on('uncaughtException', function(error) {
	console.log("*************************");
	console.log("Unhandled error occurred:");
	console.log(error.stack);
	console.log("*************************");
	var mailOptions = {
		from: "donotreply@bondageprojects.com",
		to: process.env.EMAIL_ADMIN || "",
		subject: "Bondage Club Server Crash",
		html: "Unhandled error occurred:<br />" + error.stack
	};
	MailTransporter.sendMail(mailOptions, function (err, info) {
		if (err) console.log("Error while sending error email: " + err);
		else console.log("Error email was sent");
		try {
			AccountDelayedUpdate();
		} catch (error) {
			console.log("Error while doing delayed updates");
		}
		process.exit(1);
	});
});

// When SIGTERM is received, we send a warning to all logged accounts
process.on('SIGTERM', function() {
	console.log("***********************");
	console.log("HEROKU SIGTERM DETECTED");
	console.log("***********************");
	try {
		AccountDelayedUpdate();
	} catch (error) {
		console.log("Error while doing delayed updates");
	}
	for (const Acc of Account)
		if ((Acc != null) && (Acc.Socket != null))
			Acc.Socket.emit("ServerMessage", "Server will reboot in 30 seconds." );
});

// When SIGKILL is received, we do the final updates
/*process.on('SIGKILL', function() {
	console.log("***********************");
	console.log("HEROKU SIGKILL DETECTED");
	console.log("***********************");
	try {
		AccountDelayedUpdate();
	} catch (error) {
		console.log("Error while doing delayed updates");
	}
	process.exit(2);
});*/

const IPConnections = new Map();

// Connects to the Mongo Database
DatabaseClient.connect(DatabaseURL, { useUnifiedTopology: true, useNewUrlParser: true }, function(err, db) {

	// Keeps the database object
	if (err) throw err;
	Database = db.db(DatabaseName);
	console.log("****************************************");
	console.log("Database: " + DatabaseName + " connected");

	// Gets the next unique member number
	Database.collection(AccountCollection).find({ MemberNumber : { $exists: true, $ne: null }}).sort({MemberNumber: -1}).limit(1).toArray(function(err, result) {

		// Shows the next member number
		if ((result.length > 0) && (result[0].MemberNumber != null)) NextMemberNumber = result[0].MemberNumber + 1;
		console.log("Next Member Number: " + NextMemberNumber);

		// Listens for clients on port 4288 if local or a random port if online
		App.listen(DatabasePort, function () {

			// Sets up the Client/Server events
			console.log("Bondage Club server is listening on " + (DatabasePort).toString());
			console.log("****************************************");
			IO.on("connection", function (socket) {
				let address = socket.conn.remoteAddress;

				// If there is trusted forward header set by proxy, use that instead
				// But only trust the last hop!
				if (IP_CONNECTION_PROXY_HEADER && typeof socket.handshake.headers[IP_CONNECTION_PROXY_HEADER] === "string") {
					const hops = socket.handshake.headers[IP_CONNECTION_PROXY_HEADER].split(",");
					address = hops[hops.length-1].trim();
				}

				const sameIPConnections = IPConnections.get(address) || [];

				// True, if there has already been IP_CONNECTION_RATE_LIMIT number of connections in the last second
				const ipOverRateLimit = sameIPConnections.length >= IP_CONNECTION_RATE_LIMIT && Date.now() - sameIPConnections[sameIPConnections.length - IP_CONNECTION_RATE_LIMIT] <= 1000;

				// Reject connection if over limits (rate & concurrency)
				if (sameIPConnections.length >= IP_CONNECTION_LIMIT || ipOverRateLimit) {
					console.log("Rejecting connection (IP connection limit reached) from", address);
					socket.emit("ForceDisconnect", "ErrorRateLimited");
					socket.disconnect(true);
					return;
				}

				// Connection accepted, count it
				sameIPConnections.push(Date.now());
				IPConnections.set(address, sameIPConnections);
				socket.once("disconnect", () => {
					const sameIPConnectionsDisconnect = IPConnections.get(address) || [];
					if (sameIPConnectionsDisconnect.length <= 1) {
						IPConnections.delete(address);
					} else {
						sameIPConnectionsDisconnect.shift(); // Delete first (oldest) from array
						IPConnections.set(address, sameIPConnectionsDisconnect);
					}
				});

				// Rate limit all messages and kill the connection, if limits exceeded.
				const messageBucket = [];
				for (let i = 0; i < CLIENT_MESSAGE_RATE_LIMIT; i++) {
					messageBucket.push(0);
				}
				socket.onAny(() => {
					const lastMessageTime = messageBucket.shift();
					messageBucket.push(Date.now());

					// More than CLIENT_MESSAGE_RATE_LIMIT number of messages in the last second
					if (Date.now() - lastMessageTime <= 1000) {
						// Disconnect and close connection
						socket.emit("ForceDisconnect", "ErrorRateLimited");
						socket.disconnect(true);
					}
				});

				socket.on("AccountCreate", function (data) { AccountCreate(data, socket); });
				socket.on("AccountLogin", function (data) { AccountLogin(data, socket); });
				socket.on("PasswordReset", function(data) { PasswordReset(data, socket); });
				socket.on("PasswordResetProcess", function(data) { PasswordResetProcess(data, socket); });
				AccountSendServerInfo(socket);
			});

			// Refreshes the server information to clients each 60 seconds
			setInterval(AccountSendServerInfo, 60000);

			// Updates the database appearance & skills every 150 seconds
			setInterval(AccountDelayedUpdate, 150000);

		});
	});
});

// Setups socket on successful login or account creation
function OnLogin(socket) {
	socket.removeAllListeners("AccountCreate");
	socket.removeAllListeners("AccountLogin");
	socket.removeAllListeners("PasswordReset");
	socket.removeAllListeners("PasswordResetProcess");
	socket.on("AccountUpdate", function(data) { AccountUpdate(data, socket); });
	socket.on("AccountUpdateEmail", function(data) { AccountUpdateEmail(data, socket); });
	socket.on("AccountQuery", function(data) { AccountQuery(data, socket); });
	socket.on("AccountBeep", function(data) { AccountBeep(data, socket); });
	socket.on("AccountOwnership", function(data) { AccountOwnership(data, socket); });
	socket.on("AccountLovership", function(data) { AccountLovership(data, socket); });
	socket.on("AccountDifficulty", function(data) { AccountDifficulty(data, socket); });
	socket.on("AccountDisconnect", function() { AccountRemove(socket.id); });
	socket.on("disconnect", function() { AccountRemove(socket.id); });
	socket.on("ChatRoomSearch", function(data) { ChatRoomSearch(data, socket); });
	socket.on("ChatRoomCreate", function(data) { ChatRoomCreate(data, socket); });
	socket.on("ChatRoomJoin", function(data) { ChatRoomJoin(data, socket); });
	socket.on("ChatRoomLeave", function() { ChatRoomLeave(socket); });
	socket.on("ChatRoomChat", function(data) { ChatRoomChat(data, socket); });
	socket.on("ChatRoomCharacterUpdate", function(data) { ChatRoomCharacterUpdate(data, socket); });
	socket.on("ChatRoomCharacterExpressionUpdate", function(data) { ChatRoomCharacterExpressionUpdate(data, socket); });
	socket.on("ChatRoomCharacterPoseUpdate", function(data) { ChatRoomCharacterPoseUpdate(data, socket); });
	socket.on("ChatRoomCharacterArousalUpdate", function(data) { ChatRoomCharacterArousalUpdate(data, socket); });
	socket.on("ChatRoomCharacterItemUpdate", function(data) { ChatRoomCharacterItemUpdate(data, socket); });
	socket.on("ChatRoomAdmin", function(data) { ChatRoomAdmin(data, socket); });
	socket.on("ChatRoomAllowItem", function(data) { ChatRoomAllowItem(data, socket); });
	socket.on("ChatRoomGame", function(data) { ChatRoomGame(data, socket); });
}

// Sends the server info to all players or one specific player (socket)
function AccountSendServerInfo(socket) {
	var SI = {
		Time: CommonTime(),
		OnlinePlayers: Account.length
	};
	if (socket != null) socket.emit("ServerInfo", SI);
	else IO.sockets.volatile.emit("ServerInfo", SI);
}

// Return the current time
function CommonTime() {
	return new Date().getTime();
}

// Creates a new account by creating its file
function AccountCreate(data, socket) {

	// Makes sure the account comes with a name and a password
	if ((data != null) && (typeof data === "object") && (data.Name != null) && (data.AccountName != null) && (data.Password != null) && (data.Email != null) && (typeof data.Name === "string") && (typeof data.AccountName === "string") && (typeof data.Password === "string") && (typeof data.Email === "string")) {

		// Makes sure the data is valid
		var LN = /^[a-zA-Z0-9]+$/;
		var LS = /^[a-zA-Z ]+$/;
		var E = /^[a-zA-Z0-9@.!#$%&'*+/=?^_`{|}~-]+$/;
		if (data.Name.match(LS) && data.AccountName.match(LN) && data.Password.match(LN) && (data.Email.match(E) || data.Email == "") && (data.Name.length > 0) && (data.Name.length <= 20) && (data.AccountName.length > 0) && (data.AccountName.length <= 20) && (data.Password.length > 0) && (data.Password.length <= 20) && (data.Email.length <= 100)) {

			// Checks if the account already exists
			data.AccountName = data.AccountName.toUpperCase();
			Database.collection(AccountCollection).findOne({ AccountName : data.AccountName }, function(err, result) {

				// Makes sure the result is null so the account doesn't already exists
				if (err) throw err;
				if (result != null) {
					socket.emit("CreationResponse", "Account already exists");
				} else {

					// Creates a hashed password and saves it with the account info
					BCrypt.hash(data.Password.toUpperCase(), 10, function( err, hash ) {
						if (err) throw err;
						data.Password = hash;
						data.Money = 100;
						data.Creation = CommonTime();
						data.LastLogin = CommonTime();
						data.MemberNumber = NextMemberNumber;
						data.Lovership = [];
						delete data._id;
						NextMemberNumber++;
						Database.collection(AccountCollection).insertOne(data, function(err, res) { if (err) throw err; });
						data.Environment = AccountGetEnvironment(socket);
						console.log("Creating new account: " + data.AccountName + " ID: " + socket.id + " " + data.Environment);
						data.ID = socket.id;
						data.Socket = socket;
						AccountValidData(data);
						Account.push(data);
						OnLogin(socket);
						socket.emit("CreationResponse", { ServerAnswer: "AccountCreated", OnlineID: data.ID, MemberNumber: data.MemberNumber } );
						AccountSendServerInfo(socket);
						AccountPurgeInfo(data);
					});

				}

			});

		}

	} else socket.emit("CreationResponse", "Invalid account information");

}

// Gets the current environment for online play (www.bondageprojects.com is considered production)
function AccountGetEnvironment(socket) {
	if ((socket != null) && (socket.request != null) && (socket.request.headers != null) && (socket.request.headers.origin != null) && (socket.request.headers.origin != "")) {
		if (ChatRoomProduction.indexOf(socket.request.headers.origin.toLowerCase()) >= 0) return "PROD";
		else return "DEV";
	} else return (Math.round(Math.random() * 1000000000000)).toString();
}

// Makes sure the account data is valid, creates the missing fields if we need to
function AccountValidData(Account) {
	if (Account != null) {
		if ((Account.ItemPermission == null) || (typeof Account.ItemPermission !== "number")) Account.ItemPermission = 2;
		if ((Account.WhiteList == null) || !Array.isArray(Account.WhiteList)) Account.WhiteList = [];
		if ((Account.BlackList == null) || !Array.isArray(Account.BlackList)) Account.BlackList = [];
		if ((Account.FriendList == null) || !Array.isArray(Account.FriendList)) Account.FriendList = [];
	}
}

// Purge some account info that's not required to be kept in memory on the server side
function AccountPurgeInfo(A) {
	delete A.Log;
	delete A.Skill;
	delete A.Wardrobe;
	delete A.WardrobeCharacterNames;
	delete A.ChatSettings;
	delete A.VisualSettings;
	delete A.AudioSettings;
	delete A.GameplaySettings;
	delete A.Email;
	delete A.Password;
	delete A.LastLogin;
	delete A.GhostList;
	delete A.HiddenItems;
}

// Load a single account file
function AccountLogin(data, socket) {

	// Makes sure the login comes with a name and a password
	if (!data || typeof data !== "object" || typeof data.AccountName !== "string" || typeof data.Password !== "string") {
		socket.emit("LoginResponse", "InvalidNamePassword");
		return;
	}

	// If connection already has login queued, ignore it
	if (pendingLogins.has(socket)) return;

	const shouldRun = loginQueue.length === 0;
	loginQueue.push([socket, data.AccountName.toUpperCase(), data.Password]);
	pendingLogins.add(socket);

	if (loginQueue.length > 16) {
		socket.emit("LoginQueue", loginQueue.length);
	}

	// If there are no logins being processed, start the processing of the queue
	if (shouldRun) {
		AccountLoginRun();
	}
}

/**
 * The queue of logins
 * @type {[socketio.Socket, string, string][]} - [socket, username, password]
 */
const loginQueue = [];

/**
 * List of sockets, for which there already is a pending login - to prevent duplicate logins during wait time
 * @type {WeakSet.<socketio.Socket>}
 */
const pendingLogins = new WeakSet();

/**
 * Runs the next login in queue, waiting for it to finish before running next one
 */
function AccountLoginRun() {
	// Get next waiting login
	if (loginQueue.length === 0) return;
	let nx = loginQueue[0];

	// If client disconnected during wait, ignore it
	while (!nx[0].connected) {
		pendingLogins.delete(nx[0]);
		loginQueue.shift();
		if (loginQueue.length === 0) return;
		nx = loginQueue[0];
	}

	// Process the login and after it queue the next one
	AccountLoginProcess(...nx).then(() => {
		pendingLogins.delete(nx[0]);
		loginQueue.shift();
		if (loginQueue.length > 0) {
			setTimeout(AccountLoginRun, 50);
		}
	}, err => { throw err; });
}

// Removes all instances of that character from all chat rooms
function AccountRemoveFromChatRoom(MemberNumber) {
	if ((MemberNumber == null) || (Account == null) || (Account.length == 0) || (ChatRoom == null) || (ChatRoom.length == 0)) return;
	for (let C = 0; C < ChatRoom.length; C++) {
		if ((ChatRoom[C] != null) && (ChatRoom[C].Account != null) && (ChatRoom[C].Account.length > 0)) {
			for (let A = 0; A < ChatRoom[C].Account.length; A++)
				if ((ChatRoom[C].Account[A] != null) && (ChatRoom[C].Account[A].MemberNumber != null) && (ChatRoom[C].Account[A].MemberNumber == MemberNumber))
					ChatRoom[C].Account.splice(A, 1);
			if (ChatRoom[C].Account.length == 0)
				ChatRoom.splice(C, 1);
		}
	}
}

/**
 * Processes a single login request
 * @param {socketio.Socket} socket
 * @param {string} AccountName The username the user is trying to log in with
 * @param {string} Password
 */
async function AccountLoginProcess(socket, AccountName, Password) {
	// Checks if there's an account that matches the name
	/** @type {Account|null} */
	const result = await Database.collection(AccountCollection).findOne({ AccountName });

	if (!socket.connected) return;
	if (result === null) {
		socket.emit("LoginResponse", "InvalidNamePassword");
		return;
	}

	// Compare the password to its hashed version
	const res = await BCrypt.compare(Password.toUpperCase(), result.Password);

	if (!socket.connected) return;
	if (!res) {
		socket.emit("LoginResponse", "InvalidNamePassword");
		return;
	}

	// Disconnect duplicated logged accounts
	for (const Acc of Account) {
		if (Acc != null && Acc.AccountName === result.AccountName) {
			Acc.Socket.emit("ForceDisconnect", "ErrorDuplicatedLogin");
			Acc.Socket.disconnect(true);
			AccountRemove(Acc.ID);
			break;
		}
	}

	// Assigns a member number if there's none
	if (result.MemberNumber == null) {
		result.MemberNumber = NextMemberNumber;
		NextMemberNumber++;
		console.log("Assigning missing member number: " + result.MemberNumber + " for account: " + result.AccountName);
		Database.collection(AccountCollection).updateOne({ AccountName : result.AccountName }, { $set: { MemberNumber: result.MemberNumber } }, function(err, res) { if (err) throw err; });
	}

	// Updates lovership to an array if needed for conversion
	if (!Array.isArray(result.Lovership)) result.Lovership = (result.Lovership != undefined) ? [result.Lovership] : [];

	// Sets the last login date
	result.LastLogin = CommonTime();
	Database.collection(AccountCollection).updateOne({ AccountName : result.AccountName }, { $set: { LastLogin: result.LastLogin } }, function(err, res) { if (err) throw err; });

	// Logs the account
	result.ID = socket.id;
	result.Environment = AccountGetEnvironment(socket);
	console.log("Login account: " + result.AccountName + " ID: " + socket.id + " " + result.Environment);
	AccountValidData(result);
	AccountRemoveFromChatRoom(result.MemberNumber);
	Account.push(result);
	OnLogin(socket);
	delete result.Password;
	delete result.Email;
	socket.compress(false).emit("LoginResponse", result);
	result.Socket = socket;
	AccountSendServerInfo(socket);
	AccountPurgeInfo(result);

}

// Returns TRUE if the object is empty
function ObjectEmpty(obj) {
	for(var key in obj)
		if (obj.hasOwnProperty(key))
			return false;
	return true;
}

// Updates any account data except the basic ones that cannot change
function AccountUpdate(data, socket) {
	if ((data != null) && (typeof data === "object") && !Array.isArray(data))
		for (const Acc of Account)
			if (Acc.ID == socket.id) {

				// Some data is never saved or updated from the client
				delete data.Name;
				delete data.AccountName;
				delete data.Password;
				delete data.Email;
				delete data.Creation;
				delete data.LastLogin;
				delete data.Pose;
				delete data.ActivePose;
				delete data.ChatRoom;
				delete data.ID;
				delete data._id;
				delete data.MemberNumber;
				delete data.Environment;
				delete data.Ownership;
				delete data.Lovership;
				delete data.Difficulty;
				delete data.AssetFamily;
				delete data.DelayedAppearanceUpdate;
				delete data.DelayedSkillUpdate;
				delete data.DelayedGameUpdate;

				// Some data is kept for future use
				if (data.Inventory != null) Acc.Inventory = data.Inventory;
				if (data.ItemPermission != null) Acc.ItemPermission = data.ItemPermission;
				if (data.ArousalSettings != null) Acc.ArousalSettings = data.ArousalSettings;
				if (data.OnlineSharedSettings != null) Acc.OnlineSharedSettings = data.OnlineSharedSettings;
				if (data.Game != null) Acc.Game = data.Game;
				if (data.LabelColor != null) Acc.LabelColor = data.LabelColor;
				if (data.Appearance != null) Acc.Appearance = data.Appearance;
				if (data.Reputation != null) Acc.Reputation = data.Reputation;
				if (data.Description != null) Acc.Description = data.Description;
				if (data.BlockItems != null) Acc.BlockItems = data.BlockItems;
				if (data.LimitedItems != null) Acc.LimitedItems = data.LimitedItems;
				if (data.FavoriteItems != null) Acc.FavoriteItems = data.FavoriteItems;
				if ((data.WhiteList != null) && Array.isArray(data.WhiteList)) Acc.WhiteList = data.WhiteList;
				if ((data.BlackList != null) && Array.isArray(data.BlackList)) Acc.BlackList = data.BlackList;
				if ((data.FriendList != null) && Array.isArray(data.FriendList)) Acc.FriendList = data.FriendList;
				if ((data.Lover != null) && (Array.isArray(Acc.Lovership)) && (Acc.Lovership.length < 5) && (typeof data.Lover === "string") && data.Lover.startsWith("NPC-")) {
					var isLoverPresent = false;
					for (var L = 0; L < Acc.Lovership.length; L++) {
						if ((Acc.Lovership[L].Name != null) && (Acc.Lovership[L].Name == data.Lover)) {
							isLoverPresent = true;
							break;
						}
					}
					if (!isLoverPresent) {
						Acc.Lovership.push({Name: data.Lover});
						data.Lovership = Acc.Lovership;
						for (var L = 0; L < data.Lovership.length; L++) {
							delete data.Lovership[L].BeginEngagementOfferedByMemberNumber;
							delete data.Lovership[L].BeginWeddingOfferedByMemberNumber;
							if (data.Lovership[L].BeginDatingOfferedByMemberNumber) {
								data.Lovership.splice(L, 1);
								L -= 1;
							}
						}
						socket.emit("AccountLovership", { Lovership: data.Lovership });
					}
					delete data.Lover;
				}
				if ((data.Title != null)) Acc.Title = data.Title;
				if ((data.Nickname != null)) Acc.Nickname = data.Nickname;
				if ((data.Crafting != null)) Acc.Crafting = data.Crafting;

				// Some changes should be synched to other players in chatroom
				if ((Acc != null) && Acc.ChatRoom && ["AssetFamily", "Title", "Nickname", "Crafting", "Reputation", "Description", "LabelColor", "ItemPermission", "Inventory", "BlockItems", "LimitedItems", "FavoriteItems", "OnlineSharedSettings", "WhiteList", "BlackList"].some(k => data[k] != null))
					ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.MemberNumber);

				// If only the appearance is updated, we keep the change in memory and do not update the database right away
				if ((Acc != null) && !ObjectEmpty(data) && (Object.keys(data).length == 1) && (data.Appearance != null)) {
					Acc.DelayedAppearanceUpdate = data.Appearance;
					//console.log("TO REMOVE - Keeping Appearance in memory for account: " + Acc.AccountName);
					return;
				}

				// If only the skill is updated, we keep the change in memory and do not update the database right away
				if ((Acc != null) && !ObjectEmpty(data) && (Object.keys(data).length == 1) && (data.Skill != null)) {
					Acc.DelayedSkillUpdate = data.Skill;
					//console.log("TO REMOVE - Keeping Skill in memory for account: " + Acc.AccountName);
					return;
				}

				// If only the game is updated, we keep the change in memory and do not update the database right away
				if ((Acc != null) && !ObjectEmpty(data) && (Object.keys(data).length == 1) && (data.Game != null)) {
					Acc.DelayedGameUpdate = data.Game;
					//console.log("TO REMOVE - Keeping Game in memory for account: " + Acc.AccountName);
					return;
				}

				// Removes the delayed data to update if we update that property right now
				if ((Acc != null) && !ObjectEmpty(data) && (Object.keys(data).length > 1)) {
					if ((data.Appearance != null) && (Acc.DelayedAppearanceUpdate != null)) delete Acc.DelayedAppearanceUpdate;
					if ((data.Skill != null) && (Acc.DelayedSkillUpdate != null)) delete Acc.DelayedSkillUpdate;
					if ((data.Game != null) && (Acc.DelayedGameUpdate != null)) delete Acc.DelayedGameUpdate;
				}

				// If we have data to push
				if ((Acc != null) && !ObjectEmpty(data)) Database.collection(AccountCollection).updateOne({ AccountName : Acc.AccountName }, { $set: data }, function(err, res) { if (err) throw err; });
				break;

			}
}

// Updates email address
function AccountUpdateEmail(data, socket) {
	if ((data != null) && (typeof data === "object") && (data.EmailOld != null) && (data.EmailNew != null) && (typeof data.EmailOld === "string") && (typeof data.EmailNew === "string")) {
		var Acc = AccountGet(socket.id);
		var E = /^[a-zA-Z0-9@.!#$%&'*+/=?^_`{|}~-]+$/;
		if ((Acc != null) && (data.EmailNew.match(E) || (data.EmailNew == "")) && (data.EmailNew.length <= 100) && (data.EmailNew.match(E) || (data.EmailNew == "")) && (data.EmailNew.length <= 100))
			Database.collection(AccountCollection).find({ AccountName : Acc.AccountName }).sort({MemberNumber: -1}).limit(1).toArray(function(err, result) {
				if (err) throw err;
				if ((result != null) && (typeof result === "object") && (result.length > 0) && data.EmailOld == result[0].Email) {
					socket.emit("AccountQueryResult", { Query: "EmailUpdate", Result: true });
					Database.collection(AccountCollection).updateOne({ AccountName : Acc.AccountName }, { $set: { Email: data.EmailNew }}, function(err, res) { if (err) throw err; });
					console.log("Account " + Acc.AccountName + " updated email from " + data.EmailOld + " to " + data.EmailNew);
					return;
				}
			});

		socket.emit("AccountQueryResult", { Query: "EmailUpdate", Result: false });
	}
}

// When the client account sends a query to the server
function AccountQuery(data, socket) {
	if ((data != null) && (typeof data === "object") && !Array.isArray(data) && (data.Query != null) && (typeof data.Query === "string")) {

		// Finds the current account
		var Acc = AccountGet(socket.id);
		if (Acc != null) {

			// OnlineFriends query - returns all friends that are online and the room name they are in
			if ((data.Query == "OnlineFriends") && (Acc.FriendList != null)) {

				// Add all submissives owned by the player and all lovers of the players to the list
				var Friends = [];
				var Index = [];
				for (const OtherAcc of Account) {
					var LoversNumbers = [];
					for (var L = 0; L < OtherAcc.Lovership.length; L++) {
						if (OtherAcc.Lovership[L].MemberNumber != null) { LoversNumbers.push(OtherAcc.Lovership[L].MemberNumber); }
					}
					if (OtherAcc.Environment == Acc.Environment) {
						var IsOwned = (OtherAcc.Ownership != null) && (OtherAcc.Ownership.MemberNumber != null) && (OtherAcc.Ownership.MemberNumber == Acc.MemberNumber);
						var IsLover = LoversNumbers.indexOf(Acc.MemberNumber) >= 0;
						if (IsOwned || IsLover) {
							Friends.push({ Type: IsOwned ? "Submissive" : "Lover", MemberNumber: OtherAcc.MemberNumber, MemberName: OtherAcc.Name, ChatRoomSpace: (OtherAcc.ChatRoom == null) ? null : OtherAcc.ChatRoom.Space, ChatRoomName: (OtherAcc.ChatRoom == null) ? null : OtherAcc.ChatRoom.Name, Private: (OtherAcc.ChatRoom && OtherAcc.ChatRoom.Private) ? true : undefined });
							Index.push(OtherAcc.MemberNumber);
						}
					}
				}

				// Builds the online friend list, both players must be friends to find each other
				for (var F = 0; F < Acc.FriendList.length; F++)
					if ((Acc.FriendList[F] != null) && (typeof Acc.FriendList[F] === "number"))
						if (Index.indexOf(Acc.FriendList[F]) < 0) // No need to search for the friend if she's owned
							for (const OtherAcc of Account)
								if (OtherAcc.MemberNumber == Acc.FriendList[F]) {
									if ((OtherAcc.Environment == Acc.Environment) && (OtherAcc.FriendList != null) && (OtherAcc.FriendList.indexOf(Acc.MemberNumber) >= 0))
										Friends.push({ Type: "Friend", MemberNumber: OtherAcc.MemberNumber, MemberName: OtherAcc.Name, ChatRoomSpace: ((OtherAcc.ChatRoom != null) && !OtherAcc.ChatRoom.Private) ? OtherAcc.ChatRoom.Space : null, ChatRoomName: (OtherAcc.ChatRoom == null) ? null : (OtherAcc.ChatRoom.Private) ? null : OtherAcc.ChatRoom.Name, Private: (OtherAcc.ChatRoom && OtherAcc.ChatRoom.Private) ? true : undefined });
									break;
								}

				// Sends the query result to the client
				socket.emit("AccountQueryResult", { Query: data.Query, Result: Friends });

			}

			// EmailStatus query - returns true if an email is linked to the account
			if (data.Query == "EmailStatus") {
				Database.collection(AccountCollection).find({ AccountName : Acc.AccountName }).toArray(function(err, result) {
					if (err) throw err;
					if ((result != null) && (typeof result === "object") && (result.length > 0)) {
						socket.emit("AccountQueryResult", { Query: data.Query, Result: ((result[0].Email != null) && (result[0].Email != "")) });
					}
				});
			}
		}

	}
}

// When a player wants to beep another player
function AccountBeep(data, socket) {
	if ((data != null) && (typeof data === "object") && !Array.isArray(data) && (data.MemberNumber != null) && (typeof data.MemberNumber === "number")) {

		// Make sure both accounts are online, friends and sends the beep to the friend
		var Acc = AccountGet(socket.id);
		if (Acc != null)
			for (const OtherAcc of Account)
				if (OtherAcc.MemberNumber == data.MemberNumber)
					if ((OtherAcc.Environment == Acc.Environment) && (((OtherAcc.FriendList != null) && (OtherAcc.FriendList.indexOf(Acc.MemberNumber) >= 0)) || ((OtherAcc.Ownership != null) && (OtherAcc.Ownership.MemberNumber != null) && (OtherAcc.Ownership.MemberNumber == Acc.MemberNumber)) || ((data.BeepType != null) && (typeof data.BeepType === "string") && (data.BeepType == "Leash")))) {
						OtherAcc.Socket.emit("AccountBeep", {
							MemberNumber: Acc.MemberNumber,
							MemberName: Acc.Name,
							ChatRoomSpace: (Acc.ChatRoom == null || data.IsSecret) ? null : Acc.ChatRoom.Space,
							ChatRoomName: (Acc.ChatRoom == null || data.IsSecret) ? null : Acc.ChatRoom.Name,
							Private: (Acc.ChatRoom == null || data.IsSecret) ? null : Acc.ChatRoom.Private,
							BeepType: (data.BeepType) ? data.BeepType : null,
							Message: data.Message
						});
						break;
					}

	}
}

// Updates an account appearance if needed
function AccountDelayedUpdateOne(AccountName, NewAppearance, NewSkill, NewGame) {
	if ((AccountName == null) || ((NewAppearance == null) && (NewSkill == null) && (NewGame == null))) return;
	//console.log("TO REMOVE - Updating Appearance, Skill or Game in database for account: " + AccountName);
	let UpdateObj = {};
	if (NewAppearance != null) UpdateObj.Appearance = NewAppearance;
	if (NewSkill != null) UpdateObj.Skill = NewSkill;
	if (NewGame != null) UpdateObj.Game = NewGame;
	Database.collection(AccountCollection).updateOne({ AccountName: AccountName }, { $set: UpdateObj }, function(err, res) { if (err) throw err; });
}

// Called every X seconds to update the database with appearance updates
function AccountDelayedUpdate() {
	//console.log("TO REMOVE - Scanning for account delayed updates");
	for (const Acc of Account) {
		if (Acc != null) {
			AccountDelayedUpdateOne(Acc.AccountName, Acc.DelayedAppearanceUpdate, Acc.DelayedSkillUpdate, Acc.DelayedGameUpdate);
			delete Acc.DelayedAppearanceUpdate;
			delete Acc.DelayedSkillUpdate;
			delete Acc.DelayedGameUpdate;
		}
	}
}

// Removes the account from the buffer
function AccountRemove(ID) {
	if (ID != null)
		for (const Acc of Account)
			if (Acc.ID == ID) {
				let AccName = Acc.AccountName;
				let AccDelayedAppearanceUpdate = Acc.DelayedAppearanceUpdate;
				let AccDelayedSkillUpdate = Acc.DelayedSkillUpdate;
				let AccDelayedGameUpdate = Acc.DelayedGameUpdate;
				console.log("Disconnecting account: " + Acc.AccountName + " ID: " + ID);				
				ChatRoomRemove(Acc, "ServerDisconnect", []);
				const index = Account.indexOf(Acc);
				if (index >= 0)
					Account.splice(index, 1);
				AccountDelayedUpdateOne(AccName, AccDelayedAppearanceUpdate, AccDelayedSkillUpdate, AccDelayedGameUpdate);
				break;
			}
}

// Returns the account object related to it's ID
function AccountGet(ID) {
	for (const Acc of Account)
		if (Acc.ID == ID)
			return Acc;
	return null;
}

// When a user searches for a chat room
function ChatRoomSearch(data, socket) {
	if ((data != null) && (typeof data === "object") && (data.Query != null) && (typeof data.Query === "string") && (data.Query.length <= 20)) {

		// Finds the current account
		var Acc = AccountGet(socket.id);
		if (Acc != null) {

			// Gets the chat room spaces to return (empty for public, asylum, etc.)
			var Spaces = [];
			if ((data.Space != null) && (typeof data.Space === "string") && (data.Space.length <= 100)) Spaces = [data.Space];
			else if ((data.Space != null) && (Array.isArray(data.Space)))
				data.Space.forEach(space => { if (typeof space === "string" && space.length <= 100) Spaces.push(space) });

			// Gets the game name currently being played in the chat room (empty for all games and non-games rooms)
			var Game = "";
			if ((data.Game != null) && (typeof data.Game === "string") && (data.Game.length <= 100)) Game = data.Game;

			// Checks if the user requested full rooms
			var FullRooms = false;
			if ((data.FullRooms != null) && (typeof data.FullRooms === "boolean")) FullRooms = data.FullRooms;

			// Checks if the user opted to ignore certain rooms
			var IgnoredRooms = [];
			if ((data.Ignore != null) && (Array.isArray(data.Ignore))) IgnoredRooms = data.Ignore;

			// Validate array, only strings are valid.
			var LN = /^[a-zA-Z0-9 ]+$/;
			IgnoredRooms = IgnoredRooms.filter(R => typeof R === "string" && R.match(LN));

			// Builds a list of all public rooms, the last rooms created are shown first
			var CR = [];
			var C = 0;
			for (var C = ChatRoom.length - 1; ((C >= 0) && (CR.length <= 119)); C--)
				if ((ChatRoom[C] != null) && ((FullRooms) || (ChatRoom[C].Account.length < ChatRoom[C].Limit)))
					if ((Acc.Environment == ChatRoom[C].Environment) && (Spaces.includes(ChatRoom[C].Space))) // Must be in same environment (prod/dev) and same space (hall/asylum)
						if ((Game == "") || (Game == ChatRoom[C].Game)) // If we must filter for a specific game in a chat room
							if (ChatRoom[C].Ban.indexOf(Acc.MemberNumber) < 0) // The player cannot be banned
								if ((data.Language == null) || (typeof data.Language !== "string") || (data.Language == "") || (data.Language === ChatRoom[C].Language)) // Filters by language
									if ((data.Query == "") || (ChatRoom[C].Name.toUpperCase().indexOf(data.Query) >= 0)) // Room name must contain the searched name, if any
										if (!ChatRoom[C].Locked || (ChatRoom[C].Admin.indexOf(Acc.MemberNumber) >= 0)) // Must be unlocked, unless the player is an administrator
											if (!ChatRoom[C].Private || (ChatRoom[C].Name.toUpperCase() == data.Query)) // If it's private, must know the exact name
												if (IgnoredRooms.indexOf(ChatRoom[C].Name.toUpperCase()) == -1) { // Room name cannot be ignored

													// Builds the searching account friend list in the current room
													var Friends = [];
													for (const RoomAcc of ChatRoom[C].Account)
														if (RoomAcc != null)
															if ((RoomAcc.Ownership != null) && (RoomAcc.Ownership.MemberNumber != null) && (RoomAcc.Ownership.MemberNumber == Acc.MemberNumber))
																Friends.push({ Type: "Submissive", MemberNumber: RoomAcc.MemberNumber, MemberName: RoomAcc.Name});
															else if ((Acc.FriendList != null) && (RoomAcc.FriendList != null) && (Acc.FriendList.indexOf(RoomAcc.MemberNumber) >= 0) && (RoomAcc.FriendList.indexOf(Acc.MemberNumber) >= 0))
																Friends.push({ Type: "Friend", MemberNumber: RoomAcc.MemberNumber, MemberName: RoomAcc.Name});

													// Builds a room object with all data
													CR.push({
														Name: ChatRoom[C].Name,
														Language: ChatRoom[C].Language,
														Creator: ChatRoom[C].Creator,
														CreatorMemberNumber: ChatRoom[C].CreatorMemberNumber,
														MemberCount: ChatRoom[C].Account.length,
														MemberLimit: ChatRoom[C].Limit,
														Description: ChatRoom[C].Description,
														BlockCategory: ChatRoom[C].BlockCategory,
														Game: ChatRoom[C].Game,
														Friends: Friends,
														Space: ChatRoom[C].Space
													});

												}

			// Sends the list to the client
			socket.emit("ChatRoomSearchResult", CR);

		}

	}
}

// Creates a new chat room
function ChatRoomCreate(data, socket) {

	// Make sure we have everything to create it
	if ((data != null) && (typeof data === "object") && (data.Name != null) && (data.Description != null) && (data.Background != null) && (data.Private != null) && (typeof data.Name === "string") && (typeof data.Description === "string") && (typeof data.Background === "string") && (typeof data.Private === "boolean")) {

		// Validates the room name
		data.Name = data.Name.trim();
		var LN = /^[a-zA-Z0-9 ]+$/;
		if (data.Name.match(LN) && (data.Name.length >= 1) && (data.Name.length <= 20) && (data.Description.length <= 100) && (data.Background.length <= 100)) {
			// Finds the account and links it to the new room
			var Acc = AccountGet(socket.id);
			if (Acc == null) {
				socket.emit("ChatRoomCreateResponse", "AccountError");
				return;
			}

			// Check if the same name already exists and quits if that's the case
			for (const Room of ChatRoom)
				if (Room.Name.toUpperCase().trim() == data.Name.toUpperCase().trim()) {
					socket.emit("ChatRoomCreateResponse", "RoomAlreadyExist");
					return;
				}

			// Gets the space (regular, asylum), game (none, LARP) and blocked categories of the chat room
			var Space = "";
			var Game = "";
			if ((data.Space != null) && (typeof data.Space === "string") && (data.Space.length <= 100)) Space = data.Space;
			if ((data.Game != null) && (typeof data.Game === "string") && (data.Game.length <= 100)) Game = data.Game;
			if ((data.BlockCategory == null) || !Array.isArray(data.BlockCategory)) data.BlockCategory = [];
			if (!Array.isArray(data.Ban) || data.Ban.some(i => !Number.isInteger(i))) data.Ban = [];
			if (!Array.isArray(data.Admin) || data.Admin.some(i => !Number.isInteger(i))) data.Admin = [Acc.MemberNumber];

			ChatRoomRemove(Acc, "ServerLeave", []);
			var NewRoom = {
				ID: base64id.generateId(),
				Name: data.Name,
				Language: data.Language,
				Description: data.Description,
				Background: data.Background,
				Custom: data.Custom,
				Limit: ((data.Limit == null) || (typeof data.Limit !== "string") || isNaN(parseInt(data.Limit)) || (parseInt(data.Limit) < 2) || (parseInt(data.Limit) > 10)) ? 10 : parseInt(data.Limit),
				Private: data.Private || false,
				Locked : data.Locked || false,
				Environment: Acc.Environment,
				Space: Space,
				Game: Game,
				Creator: Acc.Name,
				CreatorMemberNumber: Acc.MemberNumber,
				Creation: CommonTime(),
				Account: [],
				Ban: data.Ban,
				BlockCategory: data.BlockCategory,
				Admin: data.Admin
			};
			ChatRoom.push(NewRoom);
			Acc.ChatRoom = NewRoom;
			NewRoom.Account.push(Acc);
			console.log("Chat room (" + ChatRoom.length.toString() + ") " + data.Name + " created by account " + Acc.AccountName + ", ID: " + socket.id);
			socket.join("chatroom-" + NewRoom.ID);
			socket.emit("ChatRoomCreateResponse", "ChatRoomCreated");
			ChatRoomSync(NewRoom, Acc.MemberNumber);

		} else socket.emit("ChatRoomCreateResponse", "InvalidRoomData");

	} else socket.emit("ChatRoomCreateResponse", "InvalidRoomData");

}

// Join an existing chat room
function ChatRoomJoin(data, socket) {

	// Make sure we have everything to join it
	if ((data != null) && (typeof data === "object") && (data.Name != null) && (typeof data.Name === "string") && (data.Name != "")) {

		// Finds the current account
		var Acc = AccountGet(socket.id);
		if (Acc != null) {

			// Finds the room and join it
			for (const Room of ChatRoom)
				if (Room.Name.toUpperCase().trim() == data.Name.toUpperCase().trim())
					if (Acc.Environment == Room.Environment)
						if (Room.Account.length < Room.Limit) {
							if (Room.Ban.indexOf(Acc.MemberNumber) < 0) {

								// If the room is unlocked or the player is an admin, we allow her inside
								if (!Room.Locked || (Room.Admin.indexOf(Acc.MemberNumber) >= 0)) {
									if (Acc.ChatRoom == null || Acc.ChatRoom.ID !== Room.ID) {
										ChatRoomRemove(Acc, "ServerLeave", []);
										Acc.ChatRoom = Room;
										if (Account.find(A => Acc.MemberNumber === A.MemberNumber)) {
											Room.Account.push(Acc);
											socket.join("chatroom-" + Room.ID);
											socket.emit("ChatRoomSearchResponse", "JoinedRoom");
											ChatRoomSyncMemberJoin(Room, Acc);
											ChatRoomMessage(Room, Acc.MemberNumber, "ServerEnter", "Action", null, [{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber }]);
										}
										return;
									} else {
										socket.emit("ChatRoomSearchResponse", "AlreadyInRoom");
										return;
									}
								} else {
									socket.emit("ChatRoomSearchResponse", "RoomLocked");
									return;
								}

							} else {
								socket.emit("ChatRoomSearchResponse", "RoomBanned");
								return;
							}

						} else {
							socket.emit("ChatRoomSearchResponse", "RoomFull");
							return;
						}

			// Since we didn't found the room to join
			socket.emit("ChatRoomSearchResponse", "CannotFindRoom");

		} else socket.emit("ChatRoomSearchResponse", "AccountError");

	} else socket.emit("ChatRoomSearchResponse", "InvalidRoomData");

}

// Removes a player from a room
function ChatRoomRemove(Acc, Reason, Dictionary) {
	if (Acc.ChatRoom != null) {
		Acc.Socket.leave("chatroom-" + Acc.ChatRoom.ID);

		// Removes it from the chat room array
		for (const RoomAcc of Acc.ChatRoom.Account)
			if (RoomAcc.ID == Acc.ID) {
				Acc.ChatRoom.Account.splice(Acc.ChatRoom.Account.indexOf(RoomAcc), 1);
				break;
			}

		// Destroys the room if it's empty, warn other players if not
		if (Acc.ChatRoom.Account.length == 0) {
			for (var C = 0; C < ChatRoom.length; C++)
				if (Acc.ChatRoom.Name == ChatRoom[C].Name) {
					console.log("Chat room " + Acc.ChatRoom.Name + " was destroyed. Rooms left: " + (ChatRoom.length - 1).toString());
					ChatRoom.splice(C, 1);
					break;
				}
		} else {
			if (!Dictionary || (Dictionary.length == 0)) Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
			ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, Reason, "Action", null, Dictionary);
			ChatRoomSyncMemberLeave(Acc.ChatRoom, Acc.MemberNumber);
		}
		Acc.ChatRoom = null;

	}
}

// Finds the current account and removes it from it's chat room, nothing is returned to the client
function ChatRoomLeave(socket) {
	var Acc = AccountGet(socket.id);
	if (Acc != null) ChatRoomRemove(Acc, "ServerLeave", []);
}

// Sends a text message to everyone in the room or a specific target
function ChatRoomMessage(CR, Sender, Content, Type, Target, Dictionary) {
	if (CR == null) return;
	if (Target == null) {
		IO.to("chatroom-" + CR.ID).emit("ChatRoomMessage", { Sender: Sender, Content: Content, Type: Type, Dictionary: Dictionary } );
	} else {
		for (const Acc of CR.Account) {
			if (Acc != null && Target === Acc.MemberNumber) {
				Acc.Socket.emit("ChatRoomMessage", { Sender: Sender, Content: Content, Type: Type, Dictionary: Dictionary } );
				return;
			}
		}
	}
}

// When a user sends a chat message, we propagate it to everyone in the room
function ChatRoomChat(data, socket) {
	if ((data != null) && (typeof data === "object") && (data.Content != null) && (data.Type != null) && (typeof data.Content === "string") && (typeof data.Type === "string") && (ChatRoomMessageType.indexOf(data.Type) >= 0) && (data.Content.length <= 1000)) {
		var Acc = AccountGet(socket.id);
		if (Acc != null) ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, data.Content.trim(), data.Type, data.Target, data.Dictionary);
	}
}

// When a user sends a game packet (for LARP or other games), we propagate it to everyone in the room
function ChatRoomGame(data, socket) {
	if ((data != null) && (typeof data === "object")) {
		var R = Math.random();
		var Acc = AccountGet(socket.id);
		if (Acc && Acc.ChatRoom) {
			IO.to("chatroom-" + Acc.ChatRoom.ID).emit("ChatRoomGameResponse", { Sender: Acc.MemberNumber, Data: data, RNG: R } );
		}
	}
}

// Builds the character packet to send over to the clients, white list is only sent if there are limited items and a low item permission
function ChatRoomSyncGetCharSharedData(Acc) {
	const WhiteList = [];
	const BlackList = [];
	const sendBlacklist = AccountShouldSendBlackList(Acc);
	// We filter whitelist&blacklist based on people in room
	if (Acc.ChatRoom && Acc.ChatRoom.Account) {
		for (const B of Acc.ChatRoom.Account) {
			if (Acc.WhiteList.includes(B.MemberNumber)) {
				WhiteList.push(B.MemberNumber);
			}
			if (sendBlacklist && Acc.BlackList.includes(B.MemberNumber)) {
				BlackList.push(B.MemberNumber);
			}
		}
	}

	return {
		ID: Acc.ID,
		Name: Acc.Name,
		AssetFamily: Acc.AssetFamily,
		Title: Acc.Title,
		Nickname: Acc.Nickname,
		Appearance: Acc.Appearance,
		ActivePose: Acc.ActivePose,
		Reputation: Acc.Reputation,
		Creation: Acc.Creation,
		Lovership: Acc.Lovership,
		Description: Acc.Description,
		Owner: Acc.Owner,
		MemberNumber: Acc.MemberNumber,
		LabelColor: Acc.LabelColor,
		ItemPermission: Acc.ItemPermission,
		Inventory: Acc.Inventory,
		Ownership: Acc.Ownership,
		BlockItems: Acc.BlockItems,
		LimitedItems: Acc.LimitedItems,
		FavoriteItems: Acc.FavoriteItems,
		ArousalSettings: Acc.ArousalSettings,
		OnlineSharedSettings: Acc.OnlineSharedSettings,
		WhiteList,
		BlackList,
		Game: Acc.Game,
		Crafting: Acc.Crafting,
		Difficulty: Acc.Difficulty
	};
}

// Returns a ChatRoom data that can be synced to clients
function ChatRoomGetData(CR, SourceMemberNumber, IncludeCharacters)
{
	// Exits right away if the chat room was destroyed
	if (CR == null) return;

	// Builds the room data
	const R = {
		Name: CR.Name,
		Language: CR.Language,
		Description: CR.Description,
		Admin: CR.Admin,
		Ban: CR.Ban,
		Background: CR.Background,
		Custom: CR.Custom,
		Limit: CR.Limit,
		Game: CR.Game,
		SourceMemberNumber,
		Locked: CR.Locked,
		Private: CR.Private,
		BlockCategory: CR.BlockCategory,
		Space: CR.Space,
	};

	if (IncludeCharacters) {
		R.Character = CR.Account.map(ChatRoomSyncGetCharSharedData);
	}

	return R;
}

// Syncs the room data with all of it's members
function ChatRoomSync(CR, SourceMemberNumber) {

	// Exits right away if the chat room was destroyed
	if (CR == null) return;

	// Sends the full packet to everyone in the room
	IO.to("chatroom-" + CR.ID).emit("ChatRoomSync", ChatRoomGetData(CR, SourceMemberNumber, true));
}

// Syncs the room data with all of it's members
function ChatRoomSyncToMember(CR, SourceMemberNumber, TargetMemberNumber) {
	// Exits right away if the chat room was destroyed
	if (CR == null) { return; }

	// Sends the full packet to everyone in the room
	for (const RoomAcc of CR.Account) // For each player in the chat room...
	{
		if(RoomAcc.MemberNumber == TargetMemberNumber) // If the player is the one who gets synced...
		{
			// Send room data and break loop
			RoomAcc.Socket.emit("ChatRoomSync", ChatRoomGetData(CR, SourceMemberNumber, true));
			break;
		}
	}
}

// Syncs the room data with all of it's members
function ChatRoomSyncCharacter(CR, SourceMemberNumber, TargetMemberNumber) {
	// Exits right away if the chat room was destroyed
	if (CR == null) return;

	const Target = CR.Account.find(Acc => Acc.MemberNumber === TargetMemberNumber);
	if (!Target) return;
	const Source = CR.Account.find(Acc => Acc.MemberNumber === SourceMemberNumber);
	if (!Source) return;

	let characterData = { };
	characterData.SourceMemberNumber = SourceMemberNumber;
	characterData.Character = ChatRoomSyncGetCharSharedData(Target);

	Source.Socket.to("chatroom-" + CR.ID).emit("ChatRoomSyncCharacter", characterData);
}

// Sends the newly joined player to all chat room members
function ChatRoomSyncMemberJoin(CR, Character) {
	// Exits right away if the chat room was destroyed
	if (CR == null) return;
	let joinData = {
		SourceMemberNumber: Character.MemberNumber,
		Character: ChatRoomSyncGetCharSharedData(Character),
		WhiteListedBy: [],
		BlackListedBy: []
	};

	for (const B of CR.Account) {
		if (B.WhiteList.includes(Character.MemberNumber)) {
			joinData.WhiteListedBy.push(B.MemberNumber);
		}
		if (AccountShouldSendBlackList(B) && B.BlackList.includes(Character.MemberNumber)) {
			joinData.BlackListedBy.push(B.MemberNumber);
		}
	}

	Character.Socket.to("chatroom-" + CR.ID).emit("ChatRoomSyncMemberJoin", joinData);
	ChatRoomSyncToMember(CR, Character.MemberNumber, Character.MemberNumber);
}

// Sends the left player to all chat room members
function ChatRoomSyncMemberLeave(CR, SourceMemberNumber) {
	// Exits right away if the chat room was destroyed
	if (CR == null) return;

	let leaveData = { };
	leaveData.SourceMemberNumber = SourceMemberNumber;

	IO.to("chatroom-" + CR.ID).emit("ChatRoomSyncMemberLeave", leaveData);
}

// Syncs the room data with all of it's members
function ChatRoomSyncRoomProperties(CR, SourceMemberNumber) {

	// Exits right away if the chat room was destroyed
	if (CR == null) return;
	IO.to("chatroom-" + CR.ID).emit("ChatRoomSyncRoomProperties", ChatRoomGetData(CR, SourceMemberNumber, false));

}

// Syncs the room data with all of it's members
function ChatRoomSyncReorderPlayers(CR, SourceMemberNumber) {

	// Exits right away if the chat room was destroyed
	if (CR == null) return;

	// Builds the room data
	const newPlayerOrder = [];
	for (const RoomAcc of CR.Account) {
		newPlayerOrder.push(RoomAcc.MemberNumber);
	}

	IO.to("chatroom-" + CR.ID).emit("ChatRoomSyncReorderPlayers", { PlayerOrder: newPlayerOrder });

}

// Syncs a single character data with all room members
function ChatRoomSyncSingle(Acc, SourceMemberNumber) {
	const R = {
		SourceMemberNumber,
		Character: ChatRoomSyncGetCharSharedData(Acc)
	};
	if (Acc.ChatRoom)
		IO.to("chatroom-" + Acc.ChatRoom.ID).emit("ChatRoomSyncSingle", R);
}

// Updates a character from the chat room
function ChatRoomCharacterUpdate(data, socket) {
	if ((data != null) && (typeof data === "object") && (data.ID != null) && (typeof data.ID === "string") && (data.ID != "") && (data.Appearance != null)) {
		var Acc = AccountGet(socket.id);
		if ((Acc != null) && (Acc.ChatRoom != null))
			if (Acc.ChatRoom.Ban.indexOf(Acc.MemberNumber) < 0)
				for (const RoomAcc of Acc.ChatRoom.Account)
					if ((RoomAcc.ID == data.ID) && ChatRoomGetAllowItem(Acc, RoomAcc))
						if ((typeof data.Appearance === "object") && Array.isArray(data.Appearance)) {
							// Database.collection(AccountCollection).updateOne({ AccountName: RoomAcc.AccountName }, { $set: { Appearance: data.Appearance } }, function(err, res) { if (err) throw err; });
							//console.log("TO REMOVE - Keeping Appearance in memory for account: " + Acc.AccountName);
							if (data.Appearance != null) RoomAcc.DelayedAppearanceUpdate = data.Appearance;
							RoomAcc.Appearance = data.Appearance;
							RoomAcc.ActivePose = data.ActivePose;
							ChatRoomSyncSingle(RoomAcc, Acc.MemberNumber);
						}
	}
}

// Updates a character expression for a chat room, this does not update the database
function ChatRoomCharacterExpressionUpdate(data, socket) {
	if ((data != null) && (typeof data === "object") && (typeof data.Group === "string") && (data.Group != "")) {
		const Acc = AccountGet(socket.id);
		if (Acc && Array.isArray(data.Appearance) && data.Appearance.length >= 5)
			Acc.Appearance = data.Appearance;
		if (Acc && Acc.ChatRoom) {
			socket.to("chatroom-" + Acc.ChatRoom.ID).emit("ChatRoomSyncExpression", { MemberNumber: Acc.MemberNumber, Name: data.Name, Group: data.Group });
		}
	}
}

// Updates a character pose for a chat room, this does not update the database
function ChatRoomCharacterPoseUpdate(data, socket) {
	if ((data != null) && (typeof data === "object")) {
		if (typeof data.Pose !== "string" && !Array.isArray(data.Pose)) data.Pose = null;
		if (Array.isArray(data.Pose)) data.Pose = data.Pose.filter(P => typeof P === "string");
		var Acc = AccountGet(socket.id);
		if (Acc != null) Acc.ActivePose = data.Pose;
		if (Acc && Acc.ChatRoom) {
			socket.to("chatroom-" + Acc.ChatRoom.ID).emit("ChatRoomSyncPose", { MemberNumber: Acc.MemberNumber, Pose: data.Pose });
		}
	}
}

// Updates a character arousal meter for a chat room, this does not update the database
function ChatRoomCharacterArousalUpdate(data, socket) {
	if ((data != null) && (typeof data === "object")) {
		var Acc = AccountGet(socket.id);
		if ((Acc != null) && (Acc.ArousalSettings != null) && (typeof Acc.ArousalSettings === "object")) {
			Acc.ArousalSettings.OrgasmTimer = data.OrgasmTimer;
			Acc.ArousalSettings.OrgasmCount = data.OrgasmCount;
			Acc.ArousalSettings.Progress = data.Progress;
			Acc.ArousalSettings.ProgressTimer = data.ProgressTimer;
			if (Acc && Acc.ChatRoom) {
				socket.to("chatroom-" + Acc.ChatRoom.ID).emit("ChatRoomSyncArousal", { MemberNumber: Acc.MemberNumber, OrgasmTimer: data.OrgasmTimer, OrgasmCount: data.OrgasmCount, Progress: data.Progress, ProgressTimer: data.ProgressTimer });
			}
		}
	}
}

// Updates a character arousal meter for a chat room, this does not update the database
function ChatRoomCharacterItemUpdate(data, socket) {
	if ((data != null) && (typeof data === "object") && (data.Target != null) && (typeof data.Target === "number") && (data.Group != null) && (typeof data.Group === "string")) {

		// Make sure the source account isn't banned from the chat room and has access to use items on the target
		var Acc = AccountGet(socket.id);
		if ((Acc == null) || (Acc.ChatRoom == null) || (Acc.ChatRoom.Ban.indexOf(Acc.MemberNumber) >= 0)) return;
		for (const RoomAcc of Acc.ChatRoom.Account)
			if (RoomAcc.MemberNumber == data.Target && !ChatRoomGetAllowItem(Acc, RoomAcc))
				return;

		// Sends the item to use to everyone but the source
		if (Acc && Acc.ChatRoom) {
			socket.to("chatroom-" + Acc.ChatRoom.ID).emit("ChatRoomSyncItem", { Source: Acc.MemberNumber, Item: data });
		}
	}
}

// When an administrator account wants to act on another account in the room
function ChatRoomAdmin(data, socket) {

	if ((data != null) && (typeof data === "object") && (data.MemberNumber != null) && (typeof data.MemberNumber === "number") && (data.Action != null) && (typeof data.Action === "string")) {

		// Validates that the current account is a room administrator
		var Acc = AccountGet(socket.id);
		if ((Acc != null) && (Acc.ChatRoom != null) && (Acc.ChatRoom.Admin.indexOf(Acc.MemberNumber) >= 0)) {

			// Only certain actions can be performed by the administrator on themselves
			if (Acc.MemberNumber == data.MemberNumber && data.Action != "Swap" && data.Action != "MoveLeft" && data.Action != "MoveRight") return;

			// An administrator can update lots of room data.  The room values are sent back to the clients.
			if (data.Action == "Update")
				if ((data.Room != null) && (typeof data.Room === "object") && (data.Room.Name != null) && (data.Room.Description != null) && (data.Room.Background != null) && (typeof data.Room.Name === "string") && (typeof data.Room.Description === "string") && (typeof data.Room.Background === "string") && (data.Room.Admin != null) && (Array.isArray(data.Room.Admin)) && (!data.Room.Admin.some(i => !Number.isInteger(i))) && (data.Room.Ban != null) && (Array.isArray(data.Room.Ban)) && (!data.Room.Ban.some(i => !Number.isInteger(i)))) {
					data.Room.Name = data.Room.Name.trim();
					var LN = /^[a-zA-Z0-9 ]+$/;
					if (data.Room.Name.match(LN) && (data.Room.Name.length >= 1) && (data.Room.Name.length <= 20) && (data.Room.Description.length <= 100) && (data.Room.Background.length <= 100)) {
						for (const Room of ChatRoom)
							if (Acc.ChatRoom && Acc.ChatRoom.Name != data.Room.Name && Room.Name.toUpperCase().trim() == data.Room.Name.toUpperCase().trim()) {
								socket.emit("ChatRoomUpdateResponse", "RoomAlreadyExist");
								return;
							}
						Acc.ChatRoom.Name = data.Room.Name;
						Acc.ChatRoom.Language = data.Room.Language;
						Acc.ChatRoom.Background = data.Room.Background;
						Acc.ChatRoom.Custom = data.Room.Custom;
						Acc.ChatRoom.Description = data.Room.Description;
						if ((data.Room.BlockCategory == null) || !Array.isArray(data.Room.BlockCategory)) data.Room.BlockCategory = [];
						Acc.ChatRoom.BlockCategory = data.Room.BlockCategory;
						Acc.ChatRoom.Ban = data.Room.Ban;
						Acc.ChatRoom.Admin = data.Room.Admin;
						Acc.ChatRoom.Game = ((data.Room.Game == null) || (typeof data.Room.Game !== "string") || (data.Room.Game.length > 100)) ? "" : data.Room.Game;
						Acc.ChatRoom.Limit = ((data.Room.Limit == null) || (typeof data.Room.Limit !== "string") || isNaN(parseInt(data.Room.Limit)) || (parseInt(data.Room.Limit) < 2) || (parseInt(data.Room.Limit) > 10)) ? 10 : parseInt(data.Room.Limit);
						if ((data.Room.Private != null) && (typeof data.Room.Private === "boolean")) Acc.ChatRoom.Private = data.Room.Private;
						if ((data.Room.Locked != null) && (typeof data.Room.Locked === "boolean")) Acc.ChatRoom.Locked = data.Room.Locked;
						socket.emit("ChatRoomUpdateResponse", "Updated");
						if ((Acc != null) && (Acc.ChatRoom != null)) {
							var Dictionary = [];
							Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
							Dictionary.push({Tag: "ChatRoomName", Text: Acc.ChatRoom.Name});
							Dictionary.push({Tag: "ChatRoomLimit", Text: Acc.ChatRoom.Limit});
							Dictionary.push({Tag: "ChatRoomPrivacy", TextToLookUp: (Acc.ChatRoom.Private ? "Private" : "Public")});
							Dictionary.push({Tag: "ChatRoomLocked", TextToLookUp: (Acc.ChatRoom.Locked ? "Locked" : "Unlocked")});
							ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ServerUpdateRoom", "Action", null, Dictionary);
						}
						if ((Acc != null) && (Acc.ChatRoom != null)) ChatRoomSyncRoomProperties(Acc.ChatRoom, Acc.MemberNumber);
						return;
					} else socket.emit("ChatRoomUpdateResponse", "InvalidRoomData");
				} else socket.emit("ChatRoomUpdateResponse", "InvalidRoomData");

			// An administrator can swap the position of two characters in a room
			if ((data.Action == "Swap") && (data.TargetMemberNumber != null) && (typeof data.TargetMemberNumber === "number") && (data.DestinationMemberNumber != null) && (typeof data.DestinationMemberNumber === "number") && (data.TargetMemberNumber != data.DestinationMemberNumber)) {
				var TargetAccountIndex = Acc.ChatRoom.Account.findIndex(x => x.MemberNumber == data.TargetMemberNumber);
				var DestinationAccountIndex = Acc.ChatRoom.Account.findIndex(x => x.MemberNumber == data.DestinationMemberNumber);
				if ((TargetAccountIndex < 0) || (DestinationAccountIndex < 0)) return;
				var TargetAccount = Acc.ChatRoom.Account[TargetAccountIndex];
				var DestinationAccount = Acc.ChatRoom.Account[DestinationAccountIndex];
				const Dictionary = [
					{SourceCharacter: Acc.MemberNumber},
					{TargetCharacter: TargetAccount.MemberNumber},
					{TargetCharacter: DestinationAccount.MemberNumber, Index: 1},
				];
				Acc.ChatRoom.Account[TargetAccountIndex] = DestinationAccount;
				Acc.ChatRoom.Account[DestinationAccountIndex] = TargetAccount;
				ChatRoomSyncReorderPlayers(Acc.ChatRoom, Acc.MemberNumber);
				if ((Acc != null) && (Acc.ChatRoom != null))
					ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ServerSwap", "Action", null, Dictionary);
				return;
			}

			// If the account to act upon is in the room, an administrator can ban, kick, move, promote or demote him
			for (var A = 0; (Acc.ChatRoom != null) && (A < Acc.ChatRoom.Account.length); A++)
				if (Acc.ChatRoom.Account[A].MemberNumber == data.MemberNumber) {
					var Dictionary = [];
					if (data.Action == "Ban") {
						Acc.ChatRoom.Ban.push(data.MemberNumber);
						Acc.ChatRoom.Account[A].Socket.emit("ChatRoomSearchResponse", "RoomBanned");
						if ((Acc != null) && (Acc.ChatRoom != null) && (Acc.ChatRoom.Account[A] != null)) {
							Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
							Dictionary.push({Tag: "TargetCharacterName", Text: Acc.ChatRoom.Account[A].Name, MemberNumber: Acc.ChatRoom.Account[A].MemberNumber});
							ChatRoomRemove(Acc.ChatRoom.Account[A], "ServerBan", Dictionary);
						}
						ChatRoomSyncRoomProperties(Acc.ChatRoom, Acc.MemberNumber);
					}
					else if (data.Action == "Kick") {
						const kickedAccount = Acc.ChatRoom.Account[A];
						kickedAccount.Socket.emit("ChatRoomSearchResponse", "RoomKicked");
						if ((Acc != null) && (Acc.ChatRoom != null) && (Acc.ChatRoom.Account[A] != null)) {
							Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
							Dictionary.push({Tag: "TargetCharacterName", Text: Acc.ChatRoom.Account[A].Name, MemberNumber: Acc.ChatRoom.Account[A].MemberNumber});
							ChatRoomRemove(kickedAccount, "ServerKick", Dictionary);
						}
					}
					else if ((data.Action == "MoveLeft") && (A != 0)) {
						let MovedAccount = Acc.ChatRoom.Account[A];
						Acc.ChatRoom.Account[A] = Acc.ChatRoom.Account[A - 1];
						Acc.ChatRoom.Account[A - 1] = MovedAccount;
						Dictionary.push({Tag: "TargetCharacterName", Text: MovedAccount.Name, MemberNumber: MovedAccount.MemberNumber});
						Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
						if ((data.Publish != null) && (typeof data.Publish === "boolean") && data.Publish) ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ServerMoveLeft", "Action", null, Dictionary);
						ChatRoomSyncReorderPlayers(Acc.ChatRoom, Acc.MemberNumber);
					}
					else if ((data.Action == "MoveRight") && (A < Acc.ChatRoom.Account.length - 1)) {
						let MovedAccount = Acc.ChatRoom.Account[A];
						Acc.ChatRoom.Account[A] = Acc.ChatRoom.Account[A + 1];
						Acc.ChatRoom.Account[A + 1] = MovedAccount;
						Dictionary.push({Tag: "TargetCharacterName", Text: MovedAccount.Name, MemberNumber: MovedAccount.MemberNumber});
						Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
						if ((data.Publish != null) && (typeof data.Publish === "boolean") && data.Publish) ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ServerMoveRight", "Action", null, Dictionary);
						ChatRoomSyncReorderPlayers(Acc.ChatRoom, Acc.MemberNumber);
					}
					else if (data.Action == "Shuffle") {
						Acc.ChatRoom.Account.sort(() => Math.random() - 0.5);
						Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
						ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ServerShuffle", "Action", null, Dictionary);
						ChatRoomSyncReorderPlayers(Acc.ChatRoom, Acc.MemberNumber);
					}
					else if ((data.Action == "Promote") && (Acc.ChatRoom.Admin.indexOf(Acc.ChatRoom.Account[A].MemberNumber) < 0)) {
						Acc.ChatRoom.Admin.push(Acc.ChatRoom.Account[A].MemberNumber);
						Dictionary.push({Tag: "TargetCharacterName", Text: Acc.ChatRoom.Account[A].Name, MemberNumber: Acc.ChatRoom.Account[A].MemberNumber});
						Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
						ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ServerPromoteAdmin", "Action", null, Dictionary);
						ChatRoomSyncRoomProperties(Acc.ChatRoom, Acc.MemberNumber);
					}
					else if ((data.Action == "Demote") && (Acc.ChatRoom.Admin.indexOf(Acc.ChatRoom.Account[A].MemberNumber) >= 0)) {
						Acc.ChatRoom.Admin.splice(Acc.ChatRoom.Admin.indexOf(Acc.ChatRoom.Account[A].MemberNumber), 1);
						Dictionary.push({Tag: "TargetCharacterName", Text: Acc.ChatRoom.Account[A].Name, MemberNumber: Acc.ChatRoom.Account[A].MemberNumber});
						Dictionary.push({Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber});
						ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ServerDemoteAdmin", "Action", null, Dictionary);
						ChatRoomSyncRoomProperties(Acc.ChatRoom, Acc.MemberNumber);
					}
					return;
				}

			// Can also ban or unban without having the player in the room, there's no visible output
			if ((data.Action == "Ban") && (Acc.ChatRoom != null) && (Acc.ChatRoom.Ban.indexOf(data.MemberNumber) < 0))
			{
				Acc.ChatRoom.Ban.push(data.MemberNumber);
				ChatRoomSyncRoomProperties(Acc.ChatRoom, Acc.MemberNumber);
			}
			if ((data.Action == "Unban") && (Acc.ChatRoom != null) && (Acc.ChatRoom.Ban.indexOf(data.MemberNumber) >= 0))
			{
				Acc.ChatRoom.Ban.splice(Acc.ChatRoom.Ban.indexOf(data.MemberNumber), 1);
				ChatRoomSyncRoomProperties(Acc.ChatRoom, Acc.MemberNumber);
			}
		}

	}
}

// Returns a specific reputation value for the player
function ChatRoomDominantValue(Account) {
	if ((Account.Reputation != null) && (Array.isArray(Account.Reputation)))
		for (const Rep of Account.Reputation)
			if ((Rep.Type != null) && (Rep.Value != null) && (typeof Rep.Type === "string") && (typeof Rep.Value === "number") && (Rep.Type == "Dominant"))
				return parseInt(Rep.Value);
	return 0;
}

/**
 * Checks if account's blacklist should be sent.
 * It should only be sent if it is easily visible a person in blacklisted without this info.
 * This means if the player is on permission that blocks depending on blacklist
 * @see ChatRoomGetAllowItem
 * @param {Account} Acc The account to check
 * @returns {boolean}
 */
function AccountShouldSendBlackList(Acc) {
	return Acc.ItemPermission === 1 || Acc.ItemPermission === 2;
}

// Compares the source account and target account to check if we allow using an item
function ChatRoomGetAllowItem(Source, Target) {

	// Make sure we have the required data
	if ((Source == null) || (Target == null)) return false;
	AccountValidData(Source);
	AccountValidData(Target);

	// At zero permission level or if target is source or if owner, we allow it
	if ((Target.ItemPermission <= 0) || (Source.MemberNumber == Target.MemberNumber) || ((Target.Ownership != null) && (Target.Ownership.MemberNumber != null) && (Target.Ownership.MemberNumber == Source.MemberNumber))) return true;

	// At one, we allow if the source isn't on the blacklist
	if ((Target.ItemPermission == 1) && (Target.BlackList.indexOf(Source.MemberNumber) < 0)) return true;

	var LoversNumbers = [];
	for (const Lover of Target.Lovership) {
		if (Lover.MemberNumber != null) { LoversNumbers.push(Lover.MemberNumber); }
	}
	// At two, we allow if the source is Dominant compared to the Target (25 points allowed) or on whitelist or a lover
	if ((Target.ItemPermission == 2) && (Target.BlackList.indexOf(Source.MemberNumber) < 0) && ((ChatRoomDominantValue(Source) + 25 >= ChatRoomDominantValue(Target)) || (Target.WhiteList.indexOf(Source.MemberNumber) >= 0) || (LoversNumbers.indexOf(Source.MemberNumber) >= 0))) return true;

	// At three, we allow if the source is on the whitelist of the Target or a lover
	if ((Target.ItemPermission == 3) && ((Target.WhiteList.indexOf(Source.MemberNumber) >= 0) || (LoversNumbers.indexOf(Source.MemberNumber) >= 0))) return true;

	// At four, we allow if the source is a lover
	if ((Target.ItemPermission == 4) && (LoversNumbers.indexOf(Source.MemberNumber) >= 0)) return true;

	// No valid combo, we don't allow the item
	return false;

}

// Returns TRUE if we allow applying an item from a character to another
function ChatRoomAllowItem(data, socket) {
	if ((data != null) && (typeof data === "object") && (data.MemberNumber != null) && (typeof data.MemberNumber === "number")) {

		// Gets the source account and target account to check if we allow or not
		var Acc = AccountGet(socket.id);
		if ((Acc != null) && (Acc.ChatRoom != null))
			for (const RoomAcc of Acc.ChatRoom.Account)
				if (RoomAcc.MemberNumber == data.MemberNumber)
					socket.emit("ChatRoomAllowItem", { MemberNumber: data.MemberNumber, AllowItem: ChatRoomGetAllowItem(Acc, RoomAcc) });

	}
}

// Updates the reset password entry number or creates a new one, this number will have to be entered by the user later
function PasswordResetSetNumber(AccountName, ResetNumber) {
	for (const PasswordReset of PasswordResetProgress)
		if (PasswordReset.AccountName.trim() == AccountName.trim()) {
			PasswordReset.ResetNumber = ResetNumber;
			return;
		}
	PasswordResetProgress.push({ AccountName: AccountName, ResetNumber: ResetNumber });
}

// Generates a password reset number and sends it to the user
function PasswordReset(data, socket) {
	if ((data != null) && (typeof data === "string") && (data != "") && data.match(/^[a-zA-Z0-9@.]+$/) && (data.length >= 5) && (data.length <= 100) && (data.indexOf("@") > 0) && (data.indexOf(".") > 0)) {

		// One email reset password per 5 seconds to prevent flooding
		if (NextPasswordReset > CommonTime()) return socket.emit("PasswordResetResponse", "RetryLater");
		NextPasswordReset = CommonTime() + 5000;

		// Gets all accounts that matches the email
		Database.collection(AccountCollection).find({ Email : data }).toArray(function(err, result) {

			// If we found accounts with that email
			if (err) throw err;
			if ((result != null) && (typeof result === "object") && (result.length > 0)) {

				// Builds a reset number for each account found and creates the email body
				var EmailBody = "To reset your account password, enter your account name and the reset number included in this email.  You need to put these in the Bondage Club password reset screen, with your new password.<br /><br />";
				for (const res of result) {
					var ResetNumber = (Math.round(Math.random() * 1000000000000)).toString();
					PasswordResetSetNumber(res.AccountName, ResetNumber);
					EmailBody = EmailBody + "Account Name: " + res.AccountName + "<br />";
					EmailBody = EmailBody + "Reset Number: " + ResetNumber + "<br /><br />";
				}

				// Prepares the email to be sent
				var mailOptions = {
					from: "donotreply@bondageprojects.com",
					to: result[0].Email,
					subject: "Bondage Club Password Reset",
					html: EmailBody
				};

				// Sends the email and logs the result
				MailTransporter.sendMail(mailOptions, function (err, info) {
					if (err) {
						console.log("Error while sending password reset email: " + err);
						socket.emit("PasswordResetResponse", "EmailSentError");
					}
					else {
						console.log("Password reset email send to: " + result[0].Email);
						socket.emit("PasswordResetResponse", "EmailSent");
					}
				});

			} else socket.emit("PasswordResetResponse", "NoAccountOnEmail");

		});

	}
}

// Generates a password reset number and sends it to the user
function PasswordResetProcess(data, socket) {
	if ((data != null) && (typeof data === "object") && (data.AccountName != null) && (typeof data.AccountName === "string") && (data.ResetNumber != null) && (typeof data.ResetNumber === "string") && (data.NewPassword != null) && (typeof data.NewPassword === "string")) {

		// Makes sure the data is valid
		var LN = /^[a-zA-Z0-9 ]+$/;
		if (data.AccountName.match(LN) && data.NewPassword.match(LN) && (data.AccountName.length > 0) && (data.AccountName.length <= 20) && (data.NewPassword.length > 0) && (data.NewPassword.length <= 20)) {

			// Checks if the reset number matches
			for (const PasswordReset of PasswordResetProgress)
				if ((PasswordReset.AccountName == data.AccountName) && (PasswordReset.ResetNumber == data.ResetNumber)) {

					// Creates a hashed password and updates the account with it
					BCrypt.hash(data.NewPassword.toUpperCase(), 10, function( err, hash ) {
						if (err) throw err;
						console.log("Updating password for account: " + data.AccountName);
						Database.collection(AccountCollection).updateOne({ AccountName : data.AccountName }, { $set: { Password: hash } }, function(err, res) { if (err) throw err; });
						socket.emit("PasswordResetResponse", "PasswordResetSuccessful");
					});
					return;
				}

			// Sends a fail message to the client
			socket.emit("PasswordResetResponse", "InvalidPasswordResetInfo");

		} else socket.emit("PasswordResetResponse", "InvalidPasswordResetInfo");

	} else socket.emit("PasswordResetResponse", "InvalidPasswordResetInfo");
}

/**
 * Gets the current ownership status between two players in the same chatroom
 *
 * Can also trigger the progress in the relationship
 * @param { {
 *     MemberNumber: number;
 *     Action?: string;
 * } } data
 * @param {socketio.Socket} socket
 */
function AccountOwnership(data, socket) {
	if (data != null && typeof data === "object" && typeof data.MemberNumber === "number") {

		// The submissive can flush it's owner at any time in the trial, or after a delay if collared.  Players on Extreme mode cannot break the full ownership.
		const Acc = AccountGet(socket.id);
		if (Acc == null) return;
		if (Acc.Ownership != null && Acc.Ownership.Stage != null && Acc.Ownership.Start != null && (Acc.Ownership.Stage == 0 || Acc.Ownership.Start + OwnershipDelay <= CommonTime()) && data.Action === "Break") {
			if (Acc.Difficulty == null || Acc.Difficulty.Level == null || typeof Acc.Difficulty.Level !== "number" || Acc.Difficulty.Level <= 2 || Acc.Ownership == null || Acc.Ownership.Stage == null || typeof Acc.Ownership.Stage !== "number" || Acc.Ownership.Stage == 0) {
				Acc.Owner = "";
				Acc.Ownership = null;
				let O = { Ownership: Acc.Ownership, Owner: Acc.Owner };
				Database.collection(AccountCollection).updateOne({ AccountName : Acc.AccountName }, { $set: O }, function(err, res) { if (err) throw err; });
				socket.emit("AccountOwnership", { ClearOwnership: true });
				return;
			}
		}

		// Get the target within the chatroom
		if (Acc.ChatRoom == null) return;
		const TargetAcc = Acc.ChatRoom.Account.find(A => A.MemberNumber === data.MemberNumber);

		// Can release a target that's not in the chatroom
		if (!TargetAcc && (data.Action === "Release") && (Acc.MemberNumber != null) && (data.MemberNumber != null)) {

			// Gets the account linked to that member number, make sure
			Database.collection(AccountCollection).findOne({ MemberNumber : data.MemberNumber }, function(err, result) {
				if (err) throw err;
				if ((result != null) && (result.MemberNumber != null) && (result.MemberNumber === data.MemberNumber) && (result.Ownership != null) && (result.Ownership.MemberNumber === Acc.MemberNumber)) {
					Database.collection(AccountCollection).updateOne({ AccountName : result.AccountName }, { $set: { Owner: "", Ownership: null } }, function(err, res) { if (err) throw err; });
					ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ReleaseSuccess", "ServerMessage", Acc.MemberNumber);
					let Target = Account.find(A => A.MemberNumber === data.MemberNumber);
					if (!Target) return;
					Target.Owner = "";
					Target.Ownership = null;
					Target.Socket.emit("AccountOwnership", { ClearOwnership: true });
					if (Target.ChatRoom != null) {
						ChatRoomSyncCharacter(Target.ChatRoom, Target.MemberNumber, Target.MemberNumber);
						ChatRoomMessage(Target.ChatRoom, Target.MemberNumber, "ReleaseByOwner", "ServerMessage", Target.MemberNumber);
					}
				} else ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "ReleaseFail", "ServerMessage", Acc.MemberNumber);
			});

		}

		// Exit if there's no target
		if (!TargetAcc) return;

		// The dominant can release the submissive player at any time
		if (data.Action === "Release" && TargetAcc.Ownership != null && TargetAcc.Ownership.MemberNumber === Acc.MemberNumber) {
			const isTrial = typeof TargetAcc.Ownership.Stage !== "number" || TargetAcc.Ownership.Stage == 0;
			TargetAcc.Owner = "";
			TargetAcc.Ownership = null;
			let O = { Ownership: TargetAcc.Ownership, Owner: TargetAcc.Owner };
			Database.collection(AccountCollection).updateOne({ AccountName : TargetAcc.AccountName }, { $set: O }, function(err, res) { if (err) throw err; });
			TargetAcc.Socket.emit("AccountOwnership", { ClearOwnership: true });
			ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, isTrial ? "EndOwnershipTrial" : "EndOwnership", "ServerMessage", null, [
				{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber },
				{ Tag: "TargetCharacter", Text: TargetAcc.Name, MemberNumber: TargetAcc.MemberNumber },
			]);
			ChatRoomSyncCharacter(Acc.ChatRoom, TargetAcc.MemberNumber, TargetAcc.MemberNumber);
			return;
		}

		// In a chatroom, the dominant and submissive can enter in a BDSM relationship (4 steps to complete)
		// The dominant player proposes to the submissive player, cannot propose if target player is already owner
		if (Acc.Ownership == null ||
			Acc.Ownership.MemberNumber == null ||
			Acc.Ownership.MemberNumber != data.MemberNumber
		) {
			// Cannot propose if on blacklist
			if (TargetAcc.BlackList.indexOf(Acc.MemberNumber) < 0) {
				// Cannot propose if owned by a NPC
				if (TargetAcc.Owner == null || TargetAcc.Owner == "") {

					// If there's no ownership, the dominant can propose to start a trial (Step 1 / 4)
					if (TargetAcc.Ownership == null || TargetAcc.Ownership.MemberNumber == null) {
						// Ignore requests for self-owners
						if (Acc.MemberNumber === data.MemberNumber) return;

						if (data.Action === "Propose") {
							TargetAcc.Owner = "";
							TargetAcc.Ownership = { StartTrialOfferedByMemberNumber: Acc.MemberNumber };
							ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "OfferStartTrial", "ServerMessage", TargetAcc.MemberNumber, [{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber }]);
						} else socket.emit("AccountOwnership", { MemberNumber: data.MemberNumber, Result: "CanOfferStartTrial" });
					}

					// If trial has started, the dominant can offer to end it after the delay (Step 3 / 4)
					if (TargetAcc.Ownership != null &&
						TargetAcc.Ownership.MemberNumber == Acc.MemberNumber &&
						TargetAcc.Ownership.EndTrialOfferedByMemberNumber == null &&
						TargetAcc.Ownership.Stage === 0 &&
						TargetAcc.Ownership.Start != null &&
						TargetAcc.Ownership.Start + OwnershipDelay <= CommonTime()
					) {
						if (data.Action === "Propose") {
							TargetAcc.Ownership.EndTrialOfferedByMemberNumber = Acc.MemberNumber;
							ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "OfferEndTrial", "ServerMessage", null, [{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber }]);
						} else socket.emit("AccountOwnership", { MemberNumber: data.MemberNumber, Result: "CanOfferEndTrial" });
					}
				}
			}
		}

		// The submissive player can accept a proposal from the dominant
		// No possible interaction if the player is owned by someone else
		if (Acc.Ownership != null &&
			(Acc.Ownership.MemberNumber == null || Acc.Ownership.MemberNumber == data.MemberNumber)
		) {
			// Cannot accept if on blacklist
			if (TargetAcc.BlackList.indexOf(Acc.MemberNumber) < 0) {

				// If the submissive wants to accept to start the trial period (Step 2 / 4)
				if (Acc.Ownership.StartTrialOfferedByMemberNumber != null && Acc.Ownership.StartTrialOfferedByMemberNumber == data.MemberNumber) {
					if (data.Action === "Accept") {
						Acc.Owner = "";
						Acc.Ownership = { MemberNumber: data.MemberNumber, Name: TargetAcc.Name, Start: CommonTime(), Stage: 0 };
						let O = { Ownership: Acc.Ownership, Owner: Acc.Owner };
						Database.collection(AccountCollection).updateOne({ AccountName : Acc.AccountName }, { $set: O }, function(err, res) { if (err) throw err; });
						socket.emit("AccountOwnership", O);
						ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "StartTrial", "ServerMessage", null, [{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber }]);
						ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.MemberNumber);
					} else socket.emit("AccountOwnership", { MemberNumber: data.MemberNumber, Result: "CanStartTrial" });
				}

				// If the submissive wants to accept the full collar (Step 4 /4)
				if (Acc.Ownership.Stage != null &&
					Acc.Ownership.Stage == 0 &&
					Acc.Ownership.EndTrialOfferedByMemberNumber != null &&
					Acc.Ownership.EndTrialOfferedByMemberNumber == data.MemberNumber
				) {
					if (data.Action === "Accept") {
						Acc.Owner = TargetAcc.Name;
						Acc.Ownership = { MemberNumber: data.MemberNumber, Name: TargetAcc.Name, Start: CommonTime(), Stage: 1 };
						let O = { Ownership: Acc.Ownership, Owner: Acc.Owner };
						Database.collection(AccountCollection).updateOne({ AccountName : Acc.AccountName }, { $set: O }, function(err, res) { if (err) throw err; });
						socket.emit("AccountOwnership", O);
						ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "EndTrial", "ServerMessage", null, [{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber }]);
						ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.MemberNumber);
					} else socket.emit("AccountOwnership", { MemberNumber: data.MemberNumber, Result: "CanEndTrial" });
				}

			}
		}
	}
}

// Gets the current lovership status between two players in the same chatroom, can also trigger the progress in the relationship
function AccountLovership(data, socket) {
	if ((data != null) && (typeof data === "object") && (data.MemberNumber != null) && (typeof data.MemberNumber === "number")) {

		// Update the lovership and delete all unnecessary information
		function AccountUpdateLovership(Lovership, MemberNumber, CurrentSocket = socket, Emit = true) {
			var newLovership = Lovership.slice();
			for (var L = newLovership.length - 1; L >= 0; L--) {
				delete newLovership[L].BeginEngagementOfferedByMemberNumber;
				delete newLovership[L].BeginWeddingOfferedByMemberNumber;
				if (newLovership[L].BeginDatingOfferedByMemberNumber) {
					newLovership.splice(L, 1);
					L -= 1;
				}
			}
			var L = { Lovership: newLovership };
			Database.collection(AccountCollection).updateOne({ MemberNumber : MemberNumber}, { $set: L }, function(err, res) { if (err) throw err; });
			if (Emit) CurrentSocket.emit("AccountLovership", L);
		}

		// A Lover can break her relationship any time if not wed, or after a delay if official
		var Acc = AccountGet(socket.id);
		if ((Acc != null) && (data.Action != null) && (data.Action === "Break")) {

			var AccLoversNumbers = [];
			for (const Lover of Acc.Lovership) {
				if (Lover.MemberNumber != null) { AccLoversNumbers.push(Lover.MemberNumber); }
				else if (Lover.Name != null) { AccLoversNumbers.push(Lover.Name); }
				else { AccLoversNumbers.push(-1); }
			}
			var AL = AccLoversNumbers.indexOf(data.MemberNumber);

			// breaking with other players
			if ((Acc.Lovership != null) && (AL >= 0) && (Acc.Lovership[AL].Stage != null)
				&& (Acc.Lovership[AL].Start != null) && ((Acc.Lovership[AL].Stage != 2) || (Acc.Lovership[AL].Start + LovershipDelay <= CommonTime()))) {

				// Update the other account if she's online, then update the database
				var P = [];
				Database.collection(AccountCollection).find({ MemberNumber : data.MemberNumber }).sort({MemberNumber: -1}).limit(1).toArray(function(err, result) {
					if (err) throw err;
					if ((result != null) && (typeof result === "object") && (result.length > 0)) {
						P = result[0].Lovership;

						var TargetLoversNumbers = [];
						if ((P != null) && Array.isArray(P))
							for (const Lover of P)
								TargetLoversNumbers.push(Lover.MemberNumber ? Lover.MemberNumber : -1);

						if (Array.isArray(P)) P.splice(TargetLoversNumbers.indexOf(Acc.MemberNumber), 1);
						else P = [];

						for (const OtherAcc of Account)
							if (OtherAcc.MemberNumber == data.MemberNumber) {
								OtherAcc.Lovership = P;
								OtherAcc.Socket.emit("AccountLovership", { Lovership: OtherAcc.Lovership });
								if (OtherAcc.ChatRoom != null)
									ChatRoomSyncCharacter(OtherAcc.ChatRoom, OtherAcc.MemberNumber, OtherAcc.MemberNumber);
							}

						AccountUpdateLovership(P, data.MemberNumber, null,false);

					}

					// Make sure we don't do a double-delete in the odd case where we're breaking up with ourselves
					if (data.MemberNumber === Acc.MemberNumber) return;

					// Updates the account that triggered the break up
					if (Array.isArray(Acc.Lovership)) Acc.Lovership.splice(AL, 1);
					else Acc.Lovership = [];
					AccountUpdateLovership(Acc.Lovership, Acc.MemberNumber);
				});
				return;
			}
			// breaking with NPC
			else if ((Acc.Lovership != null) && (data.MemberNumber < 0) && (data.Name != null)) {
				Acc.Lovership.splice(AccLoversNumbers.indexOf(data.Name), 1);
				AccountUpdateLovership(Acc.Lovership, Acc.MemberNumber);
				return;
			}
		}

		// In a chatroom, two players can enter in a lover relationship (6 steps to complete)
		if ((Acc != null) && (Acc.ChatRoom != null)) {

			var AccLoversNumbers = [];
			for (const Lover of Acc.Lovership) {
				if (Lover.MemberNumber != null) { AccLoversNumbers.push(Lover.MemberNumber); }
				else if (Lover.BeginDatingOfferedByMemberNumber) { AccLoversNumbers.push(Lover.BeginDatingOfferedByMemberNumber); }
				else { AccLoversNumbers.push(-1); }
			}
			var AL = AccLoversNumbers.indexOf(data.MemberNumber);

			// One player propose to another
			if (((Acc.Lovership.length < 5) && (AL < 0)) || (AL >= 0)) // Cannot propose if target player is already a lover, up to 5 loverships
				for (const RoomAcc of Acc.ChatRoom.Account)
					if ((RoomAcc.MemberNumber == data.MemberNumber) && (RoomAcc.BlackList.indexOf(Acc.MemberNumber) < 0)) { // Cannot propose if on blacklist

						var TargetLoversNumbers = [];
						for (const RoomAccLover of RoomAcc.Lovership) {
							if (RoomAccLover.MemberNumber != null) {
								TargetLoversNumbers.push(RoomAccLover.MemberNumber);
							}
							else if (RoomAccLover.BeginDatingOfferedByMemberNumber) {
								TargetLoversNumbers.push(RoomAccLover.BeginDatingOfferedByMemberNumber);
							}
							else { TargetLoversNumbers.push(-1); }
						}
						var TL = TargetLoversNumbers.indexOf(Acc.MemberNumber);

						// Ignore requests for self-lovers
						if (Acc.MemberNumber === RoomAcc.MemberNumber) return;

						// If the target account is not a lover of player yet, can accept up to 5 loverships, one player can propose to start dating (Step 1 / 6)
						if ((RoomAcc.Lovership.length < 5) && (TL < 0)) {
							if ((data.Action != null) && (data.Action === "Propose")) {
								RoomAcc.Lovership.push({ BeginDatingOfferedByMemberNumber: Acc.MemberNumber });
								ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "OfferBeginDating", "ServerMessage", RoomAcc.MemberNumber, [{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber }]);
							} else socket.emit("AccountLovership", { MemberNumber: data.MemberNumber, Result: "CanOfferBeginDating" });
						}

						// If dating has started, a player can propose to engage after a delay (Step 3 / 6)
						if ((TL >= 0) && (RoomAcc.Lovership[TL].BeginEngagementOfferedByMemberNumber == null)
							&& (RoomAcc.Lovership[TL].Stage != null) && (RoomAcc.Lovership[TL].Start != null)
							&& (RoomAcc.Lovership[TL].Stage == 0) && (RoomAcc.Lovership[TL].Start + LovershipDelay <= CommonTime())) {
							if ((data.Action != null) && (data.Action === "Propose")) {
								RoomAcc.Lovership[TL].BeginEngagementOfferedByMemberNumber = Acc.MemberNumber;
								ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "OfferBeginEngagement", "ServerMessage", RoomAcc.MemberNumber, [{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber }]);
							} else socket.emit("AccountLovership", { MemberNumber: data.MemberNumber, Result: "CanOfferBeginEngagement" });
						}

						// If engaged, a player can propose to marry after a delay (Step 5 / 6)
						if ((TL >= 0) && (RoomAcc.Lovership[TL].BeginWeddingOfferedByMemberNumber == null)
							&& (RoomAcc.Lovership[TL].Stage != null) && (RoomAcc.Lovership[TL].Start != null)
							&& (RoomAcc.Lovership[TL].Stage == 1) && (RoomAcc.Lovership[TL].Start + LovershipDelay <= CommonTime())) {
							if ((data.Action != null) && (data.Action === "Propose")) {
								RoomAcc.Lovership[TL].BeginWeddingOfferedByMemberNumber = Acc.MemberNumber;
								ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "OfferBeginWedding", "ServerMessage", RoomAcc.MemberNumber, [{ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber }]);
							} else socket.emit("AccountLovership", { MemberNumber: data.MemberNumber, Result: "CanOfferBeginWedding" });
						}

					}

			// A player can accept a proposal from another one
			if (((Acc.Lovership.length <= 5)) && (AL >= 0)) // No possible interaction if the player has reached the number of possible lovership or if isn't already a lover
				for (const AccRoom of Acc.ChatRoom.Account)
					if ((AccRoom.MemberNumber == data.MemberNumber) && (AccRoom.BlackList.indexOf(Acc.MemberNumber) < 0)) { // Cannot accept if on blacklist

						var TargetLoversNumbers = [];
						for (const AccRoomLover of AccRoom.Lovership) {
							if (AccRoomLover.MemberNumber) {
								TargetLoversNumbers.push(AccRoomLover.MemberNumber);
							}
							else if (AccRoomLover.BeginDatingOfferedByMemberNumber) {
								TargetLoversNumbers.push(AccRoomLover.BeginDatingOfferedByMemberNumber);
							}
							else {
								TargetLoversNumbers.push(-1);
							}
						}
						var TL = TargetLoversNumbers.indexOf(Acc.MemberNumber);

						// If a player wants to accept to start dating (Step 2 / 6)
						if ((Acc.Lovership[AL].BeginDatingOfferedByMemberNumber != null) && (Acc.Lovership[AL].BeginDatingOfferedByMemberNumber == data.MemberNumber)
							&& ((AccRoom.Lovership.length < 5) || (TL >= 0))) {
							if ((data.Action != null) && (data.Action === "Accept")) {
								Acc.Lovership[AL] = { MemberNumber: data.MemberNumber, Name: AccRoom.Name, Start: CommonTime(), Stage: 0 };
								if (TL >= 0) { AccRoom.Lovership[TL] = { MemberNumber: Acc.MemberNumber, Name: Acc.Name, Start: CommonTime(), Stage: 0 }; }
								else { AccRoom.Lovership.push({ MemberNumber: Acc.MemberNumber, Name: Acc.Name, Start: CommonTime(), Stage: 0 }); }
								AccountUpdateLovership( Acc.Lovership, Acc.MemberNumber);
								AccountUpdateLovership( AccRoom.Lovership, Acc.Lovership[AL].MemberNumber, AccRoom.Socket);
								var Dictionary = [];
								Dictionary.push({ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber });
								Dictionary.push({ Tag: "TargetCharacter", Text: Acc.Lovership[AL].Name, MemberNumber: Acc.Lovership[AL].MemberNumber });
								ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "BeginDating", "ServerMessage", null, Dictionary);
								ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.MemberNumber);
								ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.Lovership[AL].MemberNumber);
							} else socket.emit("AccountLovership", { MemberNumber: data.MemberNumber, Result: "CanBeginDating" });
						}

						// If the player wants to become one's fiancée (Step 4 / 6)
						if ((Acc.Lovership[AL].Stage != null) && (Acc.Lovership[AL].Stage == 0)
							&& (Acc.Lovership[AL].BeginEngagementOfferedByMemberNumber != null) && (Acc.Lovership[AL].BeginEngagementOfferedByMemberNumber == data.MemberNumber)) {
							if ((data.Action != null) && (data.Action === "Accept")) {
								Acc.Lovership[AL] = { MemberNumber: data.MemberNumber, Name: AccRoom.Name, Start: CommonTime(), Stage: 1 };
								AccRoom.Lovership[TL] = { MemberNumber: Acc.MemberNumber, Name: Acc.Name, Start: CommonTime(), Stage: 1 };
								AccountUpdateLovership( Acc.Lovership, Acc.MemberNumber);
								AccountUpdateLovership( AccRoom.Lovership, Acc.Lovership[AL].MemberNumber, AccRoom.Socket);
								var Dictionary = [];
								Dictionary.push({ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber });
								Dictionary.push({ Tag: "TargetCharacter", Text: Acc.Lovership[AL].Name, MemberNumber: Acc.Lovership[AL].MemberNumber });
								ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "BeginEngagement", "ServerMessage", null, Dictionary);
								ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.MemberNumber);
								ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.Lovership[AL].MemberNumber);
							} else socket.emit("AccountLovership", { MemberNumber: data.MemberNumber, Result: "CanBeginEngagement" });
						}

						// If the player wants to become one's wife (Step 6 / 6)
						if ((Acc.Lovership[AL].Stage != null) && (Acc.Lovership[AL].Stage == 1)
							&& (Acc.Lovership[AL].BeginWeddingOfferedByMemberNumber != null) && (Acc.Lovership[AL].BeginWeddingOfferedByMemberNumber == data.MemberNumber)) {
							if ((data.Action != null) && (data.Action === "Accept")) {
								Acc.Lovership[AL] = { MemberNumber: data.MemberNumber, Name: AccRoom.Name, Start: CommonTime(), Stage: 2 };
								AccRoom.Lovership[TL] = { MemberNumber: Acc.MemberNumber, Name: Acc.Name, Start: CommonTime(), Stage: 2 };
								AccountUpdateLovership( Acc.Lovership, Acc.MemberNumber);
								AccountUpdateLovership( AccRoom.Lovership, Acc.Lovership[AL].MemberNumber, AccRoom.Socket);
								var Dictionary = [];
								Dictionary.push({ Tag: "SourceCharacter", Text: Acc.Name, MemberNumber: Acc.MemberNumber });
								Dictionary.push({ Tag: "TargetCharacter", Text: Acc.Lovership[AL].Name, MemberNumber: Acc.Lovership[AL].MemberNumber });
								ChatRoomMessage(Acc.ChatRoom, Acc.MemberNumber, "BeginWedding", "ServerMessage", null, Dictionary);
								ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.MemberNumber);
								ChatRoomSyncCharacter(Acc.ChatRoom, Acc.MemberNumber, Acc.Lovership[AL].MemberNumber);
							} else socket.emit("AccountLovership", { MemberNumber: data.MemberNumber, Result: "CanBeginWedding" });
						}
					}

		}

	}
}

// Sets a new account difficulty (0 is easy/roleplay, 1 is normal/regular, 2 is hard/hardcore, 3 is very hard/extreme)
function AccountDifficulty(data, socket) {
	if ((data != null) && (typeof data === "number") && (data >= 0) && (data <= 3)) {

		// Gets the current account
		var Acc = AccountGet(socket.id);
		if (Acc != null) {

			// Can only set to 2 or 3 if no change was done for 1 week
			var LastChange = ((Acc.Difficulty == null) || (Acc.Difficulty.LastChange == null) || (typeof Acc.Difficulty.LastChange !== "number")) ? Acc.Creation : Acc.Difficulty.LastChange;
			if ((data <= 1) || (LastChange + DifficultyDelay < CommonTime())) {

				// Updates the account and the database
				var NewDifficulty = { Difficulty: { Level: data, LastChange: CommonTime() } };
				Acc.Difficulty = NewDifficulty.Difficulty;
				console.log("Updating account " + Acc.AccountName + " difficulty to " + NewDifficulty.Difficulty.Level);
				Database.collection(AccountCollection).updateOne({ AccountName : Acc.AccountName }, { $set: NewDifficulty }, function(err, res) { if (err) throw err; });

			}

		}

	}
}

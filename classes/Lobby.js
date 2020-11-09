const chance = require('chance').Chance();
const deepEqual = require('deep-equal');
const { Permissions, MessageEmbed } = require('discord.js');
const { client, clientReady } = require('../discord-bot/discord-bot');
const sound = require('../sounds');
const Database = require('./Database');
const GuildConfig = require('./GuildConfig');
const UserConfig = require('./UserConfig');
const Player = require('./Player');
const Room = require('./Room');

const requiredTextPermissionsFlags = [
    'VIEW_CHANNEL',
    'SEND_MESSAGES',
    'MANAGE_MESSAGES'
];
const requiredTextPermissions = new Permissions(requiredTextPermissionsFlags);
const requiredVoicePermissionsFlags = [
    // TODO Confirm that 'CONNECT' and 'SPEAK' aren't required.
    'VIEW_CHANNEL',
    'MUTE_MEMBERS',
    'DEAFEN_MEMBERS',
    'MANAGE_NICKNAMES'
];
const requiredVoicePermissions = new Permissions(requiredVoicePermissionsFlags);

/**
 * The valid phases of a lobby.
 */
const PHASE = {
    INTERMISSION: 'Intermission',
    WORKING: 'Working',
    MEETING: 'Meeting',
    MENU: 'Menu'
};

const AUTOMATION = {
    WAITING: 'Waiting',
    CONNECTED: 'Connected',
    DISCONNECTED: 'Disconnected'
};

/**
 * Maps voice channel IDs to lobbies.
 * @type {Map<string, Lobby>}
 */
const lobbiesByVoiceChannel = new Map();

/**
 * Maps connect codes to lobbies.
 * @type {Map<string, Lobby>}
 */
const lobbiesByConnectCode = new Map();

// Connect to the database.
const database = new Database('lobbies');

// On startup, let the client and databases get ready. Then load all the stored lobbies.
console.log('Getting lobbies ready...');
const ready = clientReady
    .then(() => database.getAll())
    .then(async documents => {
        // Resume all loaded lobbies.
        await Promise.all(documents.map(async document => {
            try {
                const { voiceChannelId, textChannelId, players, infoPostId } = document;

                // Get the voice and text channels.
                const [voiceChannel, textChannel] = await Promise.all([
                    client.channels.fetch(voiceChannelId),
                    client.channels.fetch(textChannelId)
                ]);

                if (!textChannel) {
                    throw new Error(`Failed to find text channel ${textChannelId}. Cancelling lobby restoration.`);
                }

                // Alert users about the restart.
                textChannel.send("Uh oh! It looks like I may have restarted. Give me a few seconds to catch up.");

                // Delete the old info post, if any.
                await textChannel.messages.fetch(infoPostId)
                    .then(infoPost => infoPost.delete())
                    .catch(() => null);

                if (!voiceChannel) {
                    textChannel.send("Oops! Now I can't find your voice channel. You'll need to start a new lobby.");
                    throw new Error(`Failed to find voice channel ${voiceChannelId}. Cancelling lobby restoration.`);
                }

                // Restore the lobby.
                const lobby = new Lobby(voiceChannel, textChannel, document);

                // Restore all the players.
                /** @type {Player[]} */
                const restoredPlayers = await Promise.all(players.map(async player => {
                    // Get the guild member, if there is one.
                    const guildMember = player.discordId && await lobby.guild.members.fetch(player.discordId);
                    return new Player(lobby, guildMember, player);
                }));

                // Add all the restored players to the lobby.
                restoredPlayers.forEach(player => lobby._players.add(player));

                // Handle everyone still in the channel.
                await Promise.all(voiceChannel.members.map(member => lobby.guildMemberConnected(member)));

                // Handle everyone who has left.
                await Promise.all(restoredPlayers
                    .filter(player => player.discordId && !voiceChannel.members.has(player.discordId))
                    .map(player => lobby.guildMemberDisconnected(player.guildMember)));

                // Post an update.
                lobby.scheduleInfoPost({ force: true });
                lobby.scheduleSave();

            } catch (error) {
                console.error('Error resuming lobby:', error);
                await database.delete(document);
            }
        }));
    });

/**
 * @property {string} voiceChannelId - Id of the voice channel associated with the lobby.
 * @property {string} phase - Current phase of the lobby.
 * @property {Player[]} players - All the current (and past) players.
 * @property {Discord.VoiceChannel} _voiceChannel - The bound voice channel.
 * @property {Discord.TextChannel} _textChannel - The bound text channel.
 */
class Lobby {
    static get PHASE() { return PHASE; }

    static async getLobbyCount() {
        return lobbiesByVoiceChannel.size;
    }

    static async getLobbyList() {
        return [...lobbiesByVoiceChannel.values()]
            .map(lobby => `${lobby.voiceChannel.guild.name} - ${lobby.voiceChannel.name}`);
    }

    static async gatherUserData(discordId) {
        // TODO Make this more efficient, with a view or query.
        const documents = await database.getAll();
        const playerEntries = documents.map(doc => doc.players?.find(player => player?.discordId === discordId));
        return playerEntries.filter(player => player);
    }

    /**
     * Find a lobby associated with a channel id.
     *
     * @param {string|Discord.VoiceChannel} voiceChannel - Voice channel, or channel ID.
     * @returns {Promise<Lobby>} - Lobby matching the channel, or null
     */
    static async findByVoiceChannel(voiceChannel) {
        // Return immediately if no channel was provided.
        if (!voiceChannel) return null;

        // Wait for maps to populate, if near startup.
        await ready;

        // Get the voice channel id.
        const voiceChannelId = typeof voiceChannel === 'string' ? voiceChannel : voiceChannel.id;
        if (!voiceChannelId) throw new Error("Invalid voice channel.");

        // Get the lobby from the map.
        const lobby = lobbiesByVoiceChannel.get(voiceChannelId);

        // If there's a lobby, reset the timer to destroy it.
        lobby?.resetInactivityTimeout();

        // Return the lobby.
        return lobby;
    }

    /**
     * Find a lobby associated with a connect code.
     *
     * @param connectCode
     * @returns {Promise<Lobby>}
     */
    static async findByConnectCode(connectCode) {
        // Wait for maps to populate, if near startup.
        await ready;

        // Fetch the lobby by connect code.
        const lobby = connectCode && lobbiesByConnectCode.get(connectCode);

        // If there's a lobby, reset the timer to destroy it.
        lobby?.resetInactivityTimeout();

        // Return the lobby.
        return lobby;
    }

    /**
     * Create a new lobby for a channel.
     *
     * @param {VoiceChannel} voiceChannel - Voice channel, or the id of one.
     * @param {TextChannel} textChannel - Guild text channel, or the id of one.
     * @param {Room} [room] - A room to start with.
     * @returns {Promise<Lobby>}
     */
    static async start(voiceChannel, textChannel, room) {
        if (typeof voiceChannel === 'string') {
            // TODO Get the voice channel associated with the ID.
            throw new Error("Starting a channel by ID isn't supported yet.");
        }
        if (typeof textChannel === 'string') {
            // TODO Get the voice channel associated with the ID.
            throw new Error("Starting a channel by ID isn't supported yet.");
        }

        // Build a new base document.
        const document = {
            _id: voiceChannel.id,
            voiceChannelId: voiceChannel.id,
            textChannelId: textChannel.id,
            phase: PHASE.INTERMISSION,
            room
        };

        const lobby = new Lobby(voiceChannel, textChannel, document);

        // Add players
        await Promise.all(voiceChannel.members.map(member => lobby.guildMemberConnected(member)));


        // Post info.
        lobby.emit("Created");
        lobby.scheduleInfoPost();

        // Immediately save to the database.
        await lobby.save();

        // Play a greeting, asynchronously.
        lobby.speak('murder-your-friends').catch(() => {/* Do nothing */});

        // Return the new lobby.
        return lobby;
    }

    constructor(voiceChannel, textChannel, { room, ...document }) {
        if (!voiceChannel) throw new Error('A voice channel is required for a lobby.');
        if (!voiceChannel) throw new Error('A text channel is required for a lobby.');
        this._voiceChannel = voiceChannel;
        this._textChannel = textChannel;
        this._document = document;

        // Don't allow duplicate lobbies.
        if (lobbiesByVoiceChannel.has(voiceChannel.id)) throw new Error("There's already a lobby in that channel.");

        // Make sure the discord bot has sufficient permissions.
        if (!voiceChannel.permissionsFor(voiceChannel.guild.me).has(requiredVoicePermissions)) throw new Error([
            'Sorry, I don\'t have enough permissions in that voice channel.',
            `I need the following:\n\t- ${requiredVoicePermissionsFlags.join('\n\t- ')}`
        ].join('\n'));
        if (!textChannel.permissionsFor(textChannel.guild.me).has(requiredTextPermissions)) throw new Error([
            'Sorry, I don\'t have enough permissions in this text channel.',
            `I need the following:\n\t- ${requiredTextPermissionsFlags.join('\n\t- ')}`
        ].join('\n'));

        // Verify the phase.
        if (!document.phase) document.phase = PHASE.INTERMISSION;
        if (!Object.values(PHASE).includes(document.phase)) throw new Error("Invalid lobby phase");

        // If there's no connect code in the document, create one.
        if (!this.connectCode) document.connectCode = chance.string({ length: 8, casing: 'upper', alpha: true });

        // Create a map to hold the players.
        /**
         * Stores players by their Discord user id.
         * @type {Set<Player>}
         * @private
         */
        this._players = new Set();
        // TODO Make players properly serializable.

        // Store the room.
        if (room) this._document.room = new Room(room);

        // Update the connection status
        // TODO Verify that this doesn't need to be serialized.
        this.automation = AUTOMATION.WAITING;

        // Store this in the maps.
        lobbiesByVoiceChannel.set(voiceChannel.id, this);
        lobbiesByConnectCode.set(this.connectCode, this);

        // Start the inactivity timeout.
        this.resetInactivityTimeout();
    }

    /**
     * Get the guild for the lobby.
     * @returns {Discord.Guild}
     */
    get guild() { return this._voiceChannel.guild; }

    /**
     * Get the underlying voice channel for the lobby.
     * @returns {Discord.VoiceChannel}
     */
    get voiceChannel() { return this._voiceChannel; }


    /**
     * Get the text channel used for the lobby.
     * @returns {Discord.TextChannel}
     */
    get textChannel() { return this._textChannel; }

    /**
     * Return the players as an array.
     * @returns {Player[]}
     */
    get players() { return [...this._players];}

    get phase() { return this._document.phase; }

    /**
     * @returns {boolean} - Whether or not the lobby is currently transitioning between phases.
     */
    get transitioning() {return Boolean(this._transitioning);}

    get connectCode() {return this._document.connectCode;}

    get room() {return this._document.room;};

    async updateRoom(room) {
        if (!room) delete this._document.room;
        else {
            this._document.room = new Room(room);
            if (this.phase !== PHASE.MENU) await this.speak('new-room-code');
        }
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    emit(message) {
        console.log(`Lobby ${this.voiceChannel.id}: ${message}`);
    }

    async updateAutomationConnection(connected) {
        // Make an announcement the first time capture connects.
        if (this.automation === AUTOMATION.WAITING && connected) await this.speak('capture-connected');
        this.automation = connected ? AUTOMATION.CONNECTED : AUTOMATION.DISCONNECTED;
        this.scheduleInfoPost();
    }

    async getGuildConfig(key) {
        const guildConfig = await GuildConfig.load(this.voiceChannel.guild.id);
        return key ? guildConfig.get(key) : guildConfig;
    }

    /**
     * Searches for players in the lobby.
     *
     * @param {Discord.GuildMember|string} guildMember
     * @returns {Player}
     */
    getGuildMemberPlayer(guildMember) {
        // TODO Store a map of these, rather than a slow search.
        if (!guildMember) return undefined;
        return this.players.find(player => player.matchesGuildMember(guildMember));
    }

    /**
     * Find a player with a matching in-game name.
     * @param {string} name - In-game name from Among Us.
     * @returns {Player}
     */
    getAmongUsPlayer(name) {
        // TODO Store a map of these, rather than a slow search.
        if (!name) return undefined;
        return this.players.find(player => player.matchesAmongUsName(name));
    }

    async amongUsJoin({ name, color, dead }, allowAutoJoin = true) {
        let player = this.getAmongUsPlayer(name);

        // If there's no player yet, try to auto-join them.
        if (!player && allowAutoJoin) {
            // Look for a valid auto-join target.
            if (await this.getGuildConfig('autojoin')) {
                const spectators = this.players.filter(player => player.isSpectating);
                const playerCache = await Promise.all(spectators.map(async player => {
                    const { amongUsName } = await UserConfig.load(player.discordId);
                    return { player, amongUsName };
                }));

                // Find all matching players.
                const matchingPlayers = playerCache
                    .filter(({ amongUsName }) => amongUsName === name)
                    .map(({ player }) => player);

                // Only auto-join if there's exactly one matching player.
                if (matchingPlayers.length === 1) {
                    player = matchingPlayers[0];
                    this.emit(`Auto-join guild member ${player.discordId} as "${name}".`);
                    player.joinGame(name);
                }
            }
        }

        // If there's still no player, create one.
        if (!player) {
            player = new Player(this);
            this._players.add(player);
            player.joinGame(name);
        }

        if ((!player || !player.discordId)) {
            this.textChannel.send(`Hello ${name}, please react to this message`).then(async (message) => {
                const collector = message.createReactionCollector(() => true, { time: 60000, max: 1 });

                collector.on('collect', async (reaction, user) => {
                    const member = reaction.message.guild.members.cache.find(member => member.id === user.id);
                    await this.guildMemberJoin(member, name);
                    if (message.deletable) {
                        message.delete().catch(() => {/* Do nothing */});
                    }
                });

                collector.on('end', () => { if (message.deletable) message.delete().catch(() => {/* Do nothing */}) });
            });
        }

        // Update their color.
        player.amongUsColor = color;

        // Start them in the appropriate status.
        dead ? player.kill() : player.revive();
        await this.setPlayerForCurrentPhase(player);

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    async amongUsLeave({ name }) {
        let player = this.getAmongUsPlayer(name);

        // Ignore players that are no longer tracked. (This happens frequently after starting a new game.)
        if (!player) return;

        // If the player is on Discord, disconnect them.
        const { guildMember } = player;
        if (guildMember) {
            player.amongUsColor = null;
            // Remove the player from the game, making them a spectator.
            await player.leaveGame();

            // If they're no longer in the voice channel, disconnect them entirely.
            const { voice } = await guildMember.fetch();
            if (voice?.channelID !== this.voiceChannel.id) await this.guildMemberDisconnected(guildMember);

            // If The lobby ended because of that disconnect, return immediately.
            if (this.stopped) return;
        }

        // Otherwise, just remove them from the game entirely.
        else this._players.delete(player);

        // TODO Keep dead players around until the end of the match.

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    async amongUsKill({ name }) {
        let player = this.getAmongUsPlayer(name);
        if (!player) throw new Error(`amongUsKill order for "${name}" but no such player.`);

        // Kill the player.
        player.kill();
        await this.setPlayerForCurrentPhase(player);

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    async amongUsExile({ name }) {
        let player = this.getAmongUsPlayer(name);
        if (!player) throw new Error(`amongUsExile order for "${name}" but no such player.`);

        // Kill the player.
        player.instantKill();
        await this.setPlayerForCurrentPhase(player);

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    async amongUsForceUpdate({ name, color, dead, disconnected }) {
        if (disconnected) {
            // TODO Handle disconnected players.
            return;
        }

        // For everyone else, add/update them (without auto-join)
        await this.amongUsJoin({ name, color, dead, disconnected });
    }

    async guildMemberJoin(guildMember, amongUsName) {
        // Ignore bots.
        if (guildMember.user.bot) return null;

        // Check if the player is already in this lobby.
        const player = this.getGuildMemberPlayer(guildMember);
        if (!player) throw new Error(`Guild member (${guildMember.name} isn't in the lobby.`);

        // Check for an existing player with that name.
        const existingPlayer = this.players.find(player => player.matchesAmongUsName(amongUsName));
        if (existingPlayer) {
            // Don't allow duplicate names between guild members.
            if (existingPlayer.discordId) throw new Error(`The name "${amongUsName}" is already taken.`);

            // Link the guild member to the existing player.
            existingPlayer.linkGuildMember(guildMember);
            await this.setPlayerForCurrentPhase(existingPlayer);

            // Remove the spectating guild member.
            this._players.delete(player);

            this.emit(`Linked discord user ${existingPlayer.discordName} with name "${amongUsName}"`);
        }

        // Otherwise, set the player's name and add them to the game.
        else {
            player.joinGame(amongUsName);
            await this.setPlayerForCurrentPhase(player);
        }

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    async guildMemberQuit(guildMember) {
        // Ignore bots.
        if (guildMember.user.bot) return null;

        // Check if the player is already in this lobby.
        const player = this.getGuildMemberPlayer(guildMember);
        if (!player) throw new Error(`Guild member (${guildMember.name} isn't in the lobby.`);
        if (player.isSpectating) throw new Error("You're already a spectator.");

        // Gather player information, if we need to create a new one.
        const color = player.amongUsColor;
        const name = player.amongUsName;
        const dead = player.isDeadOrDying;

        // Mark the player as having left.
        await player.leaveGame();
        await this.setPlayerForCurrentPhase(player);

        // If the player was being tracked by automation, create a new one. (Without auto-joining.)
        if (color) await this.amongUsJoin({ name, color, dead }, false);

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }


    async guildMemberEject(...members) {
        // Process all submitted members.
        await Promise.all(members
            .filter(member => !member.user.bot)
            .map(async member => {
                // Get the player.
                const player = this.getGuildMemberPlayer(member);

                // Ignore spectators.
                if (player.isSpectating) return;

                // Update the player as though they quit.
                await this.guildMemberQuit(member);

                // Remove the player if they've already left the channel.
                if (!this.voiceChannel.members.has(member.id)) this._players.delete(player);
            }));

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    async guildMemberConnected(guildMember, allowAutoJoin = true) {
        // Ignore bots.
        if (guildMember.user.bot) return null;

        // Fetch the existing player, or create a new spectator.
        let player = this.getGuildMemberPlayer(guildMember);
        if (!player) {
            player = new Player(this, guildMember);
            this._players.add(player);
        }

        // Auto-join, if enabled.
        if (allowAutoJoin && player.isSpectating) {
            if (await this.getGuildConfig('autojoin')) {
                const { amongUsName } = await UserConfig.load(guildMember.id);
                const existingPlayer = this.getAmongUsPlayer(amongUsName);
                if (existingPlayer && !existingPlayer.discordId) {
                    this.emit(`Auto-join guild member ${guildMember.id} as "${amongUsName}".`);
                    return this.guildMemberJoin(guildMember, amongUsName);
                }
            }
        }

        // Make sure their voice state matches the current game phase.
        await this.setPlayerForCurrentPhase(player);

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    async guildMemberDisconnected(guildMember) {
        // Ignore bots.
        if (guildMember.user.bot) return null;

        const player = this.getGuildMemberPlayer(guildMember);
        if (!player) throw new Error("Guild member disconnected without ever having connected.");

        // If the player was spectating, remove them.
        if (player.isSpectating) this._players.delete(player);

        // Unmute the player, for having left the channel.
        await player.editGuildMember(false, false, "Left Voice Channel", true);

        // End the lobby if there are no more connected players.
        const gameIsInMenu = this.phase === PHASE.MENU;
        const gameHasNoGuildMembers = this.players.every(player => !player.guildMember);
        const channelIsEmpty = this.voiceChannel.members.array().every(member => member?.user?.bot);
        if (gameHasNoGuildMembers || (channelIsEmpty && gameIsInMenu)) {
            await this.stop("All the Discord users left, so I ended the lobby.");
        }
        else {
            // Schedule updates.
            this.scheduleInfoPost();
            this.scheduleSave();
        }
    }


    /**
     * Kill the player(s) passed in.
     * Accepts arbitrarily many GuildMembers as arguments.
     *
     * @param {Discord.GuildMember} members
     * @returns {Promise<void>}
     */
    async guildMemberKill(...members) {
        if (this.phase === PHASE.INTERMISSION || this.phase === PHASE.MENU) {
            throw new Error("You can't kill people outside games.");
        }

        // Generate kill orders for each member passed in.
        const killOrders = members.map(async member => {
            // If the member is a player is in this lobby, mark them as dying and update their state.
            const player = this.getGuildMemberPlayer(member);
            if (player) {
                player.kill();
                await this.setPlayerForCurrentPhase(player);
            }
        });

        // Wait for all the kill orders to finish processing.
        await Promise.all(killOrders);

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    /**
     * Revive the player(s) passed in.
     * Accepts arbitrarily many GuildMembers as arguments.
     *
     * @param {Discord.GuildMember} members
     * @returns {Promise<void>}
     */
    async guildMemberRevive(...members) {
        // Generate revival orders for each member passed in.
        const reviveOrders = members.map(async member => {
            // If the member is a player is in this lobby, mark them as living and update their state.
            const player = this.getGuildMemberPlayer(member);
            if (player) {
                player.revive();
                await this.setPlayerForCurrentPhase(player);
            }
        });

        // Wait for all the revival orders to finish processing.
        await Promise.all(reviveOrders);

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    /**
     * Transition to the new phase.
     *
     * @param {string} targetPhase
     * @returns {Promise<void>}
     */
    async transition(targetPhase) {
        // Prevent multiple or duplicate transitions.
        if (this.transitioning) throw new Error("The lobby is already transitioning between phases");
        if (this.phase === targetPhase) throw new Error(`The lobby is already in the ${targetPhase} phase`);

        // Mark the transition and switch to the new phase.
        this._transitioning = true;
        this._document.phase = targetPhase;

        // Sort players into batches, to avoid cross-talk.
        const participants = [];
        const workers = [];
        const nonWorkers = [];
        const spectators = [];
        this.players.forEach(player => {
            player.isSpectating ? spectators.push(player) : participants.push(player);
            player.isWorker ? workers.push(player) : nonWorkers.push(player);
        });

        // Handle the transition.
        this.emit(`Transitioning to ${targetPhase}`);
        switch (targetPhase) {
            case PHASE.MENU:
                // Delete the room code.
                await this.updateRoom(null);

                // Unmute all discord users and delete everyone else.
                await Promise.all(this.players.map(async player => {
                    if (player.guildMember) await player.setForIntermission();
                    else this._players.delete(player);

                }));
                break;
            case PHASE.INTERMISSION:
                await Promise.all(participants.map(player => player.setForIntermission()));
                await Promise.all(spectators.map(player => player.setForIntermission()));
                break;

            case PHASE.WORKING:
                // Update workers first, to avoid cross-talk, then everyone else.
                await Promise.all(workers.map(player => player.setForWorking()));
                await Promise.all(nonWorkers.map(player => player.setForWorking()));
                break;

            case PHASE.MEETING:
                // Update non-workers first, to avoid cross-talk, then everyone else.
                await Promise.all(nonWorkers.map(player => player.setForMeeting()));
                await Promise.all(workers.map(player => player.setForMeeting()));
                break;

            default:
                throw new Error("Invalid target phase");
        }

        delete this._transitioning;
        this.emit(`Entered ${targetPhase}`);

        // Schedule updates.
        this.scheduleInfoPost();
        this.scheduleSave();
    }

    /**
     * Updates the given player so they match the current phase.
     * @param {Player} player
     */
    async setPlayerForCurrentPhase(player) {
        switch (this.phase) {
            case PHASE.MENU:
            case PHASE.INTERMISSION:
                return player.setForIntermission();
            case PHASE.WORKING:
                return player.setForWorking();
            case PHASE.MEETING:
                return player.setForMeeting();
            default:
                throw new Error("Invalid target phase");
        }
    }

    /**
     * Post information about the lobby to the text channel.
     * @param {object} [options]
     * @param {boolean} [options.spoil] - Display Living and Dying players during the working phase.
     * @param {boolean} [options.force] - Post a new update, even if it's identical to the last one.
     * @returns {module:"discord.js".MessageEmbed}
     */
    async scheduleInfoPost(options = {}) {
        // Get the guild command prefix for command hints.
        const guildConfig = await this.getGuildConfig();
        const prefix = guildConfig.defaultPrefix;

        // Get and all the players.
        const everyone = this.players; // TODO Put them in some sorted order.

        // Create the embed.
        const embed = new MessageEmbed();

        // Handle the menu phase differently.
        if (this.phase === PHASE.MENU) {
            const menuMessage = [
                "The host is the game menu right now, but hang in there.",
                "As soon as they create a new game, I'll post the room code!"
            ].join('\n');
            const people = everyone
                .filter(player => player.discordId)
                .map(player => `:stopwatch: <@${player.discordId}>`)
                .join('\n');

            embed.setTitle(`Among Us - Getting ready in "${this.voiceChannel.name}"`)
                .addField('Ready to play?', menuMessage)
                .addField('People Waiting', people);
        }

        // Otherwise, treat the other phases similarly.
        else {
            const roomInfo = this.room ? `**${this.room.code}** (${this.room.region})` : 'Not Listed';

            // Build a display for all the players.
            const players = everyone.filter(player => !player.isSpectating);
            const playerList = players.map(player => {
                const name = player.discordId ? `<@${player.discordId}>` : player.amongUsName;
                const hasNameMismatch = player.discordName && player.discordName !== player.amongUsName;
                const mismatchDisplay = hasNameMismatch ? ` (${player.amongUsName})` : '';
                const color = player.amongUsColor ?? 'Untracked';

                if (this.phase === PHASE.INTERMISSION) {
                    return `:stopwatch: ${name}${mismatchDisplay} (${color})`;
                }
                else {
                    const showStatus = options.spoil || !player.isWorker || this.phase !== PHASE.WORKING;
                    const status = showStatus ? player.status : '_Working_';
                    const emoji = player.isWaiting ? ':stopwatch:' : (player.isKnownDead ? ':skull:' : ':heartpulse:');
                    return `${emoji} ${status}: ${name}${mismatchDisplay} (${color})`;
                }
            }).join('\n') || 'None';

            // Build a display for all the spectators.
            const spectators = everyone.filter(player => player.isSpectating);
            const spectatorList = spectators.map(player => `<@${player.discordId}>`).join('\n');

            // Update the embed.
            embed.setTitle(`Among Us - ${this.phase} in "${this.voiceChannel.name}"`)
                .addField('Room Code', roomInfo)
                .addField(`Players (${players.length})`, playerList, true);

            // Add spectators and join info, if necessary.
            if (spectatorList) {
                const spectatorName = spectators.length > 1 ? 'Spectators' : `<@${spectators[0].discordId}>`;
                embed.addField('Spectators', spectatorList, true);
                embed.addField('Join the Game!', [
                    `Hey, ${spectatorName}! You wanna get in on this?`,
                    `Use \`${prefix} join <In-Game Name>\` to join! (_Without the brackets._)`,
                    "\n**But you should know:**",
                    "If you join a lobby, _the bot will store some data about you_.",
                    `You can use \`${prefix} privacy\` to review our privacy policy first.`
                ].join('\n'));
            }

        }

        // Attach the capture status.
        embed.setFooter(
            `Capture Status: ${this.automation}`
        );

        // If there's a text channel bound, send the embed to it.
        if (this.textChannel) {
            // Reset any existing timeout, to prevent spamming.
            if (this._nextInfoPostTimeout) {
                clearTimeout(this._nextInfoPostTimeout);
                delete this._nextInfoPostTimeout;
            }
            // Create a new timeout, to post an update after a short delay.
            this._nextInfoPostTimeout = setTimeout(async () => {
                // If the lobby stopped since the timeout was scheduled, do nothing.
                if (this.stopped) return;

                // Clean up the last timeout.
                delete this._nextInfoPostTimeout;

                // Skip the post if it's the same as the last one.
                if (this._lastInfoPosted && !options.force) {
                    const [lastEmbed] = this._lastInfoPosted.embeds;
                    if (deepEqual(lastEmbed.toJSON(), embed.toJSON())) return;
                }
                // Post a new message.
                const messageSent = await this.textChannel.send(embed);
                await this.deleteLastLobbyInfo().catch(error => console.error(error));
                this._lastInfoPosted = messageSent;
                this._document.infoPostId = messageSent.id;
                this.scheduleSave();
            }, 500);
        }

        return embed;
    }

    async deleteLastLobbyInfo() {
        // If there was an old message, delete it.
        const messageToDelete = this._lastInfoPosted;
        delete this._lastInfoPosted;
        if (messageToDelete?.deletable) await messageToDelete.delete();
    }

    async speak(file, onFinish) {
        // Do nothing if this guild has speech disabled.
        if (!await this.getGuildConfig('speech')) return;

        try {
            // First, see if we need to join the channel.
            if (!this.voiceConnection) {
                const { voiceChannel } = this;
                if (voiceChannel.joinable && voiceChannel.speakable) {
                    this.voiceConnection = await voiceChannel.join();
                    this.voiceConnection.setSpeaking('PRIORITY_SPEAKING');
                }
            }

            // Then try to play.
            const dispatcher = this.voiceConnection?.play(sound(file));

            // Schedule the follow-on task.
            if (dispatcher && onFinish) dispatcher.once('finish', onFinish);
        } catch (error) {
            console.error("Failed to play sound:", error);
        }
    }

    async stop(reason) {
        // Giver straggling processes a way to check that this lobby was ended.
        this.stopped = true;

        // Announce to users, then leave the channel.
        if (this.voiceChannel.members.array().some(member => !member?.user?.bot)) {
            await this.speak('see-you-later', () => {this.voiceChannel.leave();});
        }
        else this.voiceChannel.leave();

        // Unlink the maps.
        lobbiesByVoiceChannel.delete(this.voiceChannel.id);
        lobbiesByConnectCode.delete(this.connectCode);

        // Reset all players.
        await Promise.all(this.players.map(player => player.leaveGame()));

        // Delete the lobby from the database.
        this.cancelScheduledSave();
        await database.delete(this._document);

        // Clear the timeout.
        if (this._inactivityTimeout) clearTimeout(this._inactivityTimeout);

        // Delete the last lobby info.
        await this.deleteLastLobbyInfo();

        // Create a lobby-over embed.
        const { defaultPrefix } = await this.getGuildConfig();
        const restartMessage = `If you want to play again, just start a new lobby with \`${defaultPrefix} start\`!`;
        const embed = new MessageEmbed()
            .setTitle(`Among Us - Ended lobby in "${this.voiceChannel.name}"`)
            .setDescription(reason)
            .addField('Thanks for playing!', restartMessage);
        await this.textChannel.send(embed);

        this.emit("Destroyed");
    }

    resetInactivityTimeout() {
        if (this._inactivityTimeout) clearTimeout(this._inactivityTimeout);
        this._inactivityTimeout = setTimeout(() => {
            // If the lobby stopped since the timeout was scheduled, do nothing.
            if (this.stopped) return;

            // Terminate the lobby.
            this.emit('Terminating due to inactivity.');
            this.stop("Nothing has happened in an hour, so I ended the lobby.")
                .catch(error => console.error(error));
        }, 1000 * 60 * 60);
    }

    cancelScheduledSave() {
        if (this._nextSaveTimeout) {
            clearTimeout(this._nextSaveTimeout);
            delete this._nextSaveTimeout;
        }
    }

    scheduleSave() {
        // Reset any existing timeout, to reduce database load.
        this.cancelScheduledSave();

        // Create a new timeout, to save after a short delay.
        this._nextSaveTimeout = setTimeout(() => {
            // If the lobby stopped since the timeout was scheduled, do nothing.
            if (this.stopped) return;

            delete this._nextSaveTimeout;
            this.save();
        }, 1500);
    }

    save() {
        database.set(this.toJSON())
            .then(({ id, rev }) => {
                this._document._id = id;
                this._document._rev = rev;
            })
            .catch(error => console.error(error));

    }

    toJSON() {
        const { players } = this;
        const { ...document } = this._document;
        document.players = players.map(player => player.toJSON());
        return document;
    }
}

module.exports = Lobby;
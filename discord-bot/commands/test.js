const { requireLobby } = require('./_helpers');


module.exports = async function testCommand(message) {
    const lobby = await requireLobby(message);

    const player = await lobby.getPlayer(message.member);

    await message.reply("Starting mute/deaf rate limit test...")

    // Test the rate limit.
    console.log("MuteDeaf 1");
    await player.setMuteDeaf(false, false)
    console.log("MuteDeaf 2");
    await player.setMuteDeaf(false, true)
    console.log("MuteDeaf 3");
    await player.setMuteDeaf(true, false)
    console.log("MuteDeaf 4");
    await player.setMuteDeaf(true, true)
    console.log("MuteDeaf 5");
    await player.setMuteDeaf(false, false)
    console.log("MuteDeaf 6");
    await player.setMuteDeaf(false, true)
    console.log("MuteDeaf 7");
    await player.setMuteDeaf(true, false)
    console.log("MuteDeaf 8");
    await player.setMuteDeaf(true, true)
    console.log("MuteDeaf 0");
    await player.setMuteDeaf(false, false)
    console.log("MuteDeaf 10");
    await player.setMuteDeaf(false, true)
    console.log("MuteDeaf 11");
    await player.setMuteDeaf(true, false)
    console.log("MuteDeaf 12");
    await player.setMuteDeaf(true, true)
    console.log("Completed MuteDeaf test");

    await message.reply("Finished mute/deaf rate limit test.")
};
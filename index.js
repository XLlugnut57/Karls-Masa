const {Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType} = require("discord.js");
const http = require('http');

// Use environment variables in production, fallback to config.json for local development
let token, targetUserId;

console.log("Checking environment variables...");
console.log("DISCORD_TOKEN exists:", !!process.env.DISCORD_TOKEN);
console.log("TARGET_USER_ID exists:", !!process.env.TARGET_USER_ID);

if (process.env.DISCORD_TOKEN && process.env.TARGET_USER_ID) {
    // Production environment (Railway)
    console.log("Using environment variables");
    token = process.env.DISCORD_TOKEN;
    targetUserId = process.env.TARGET_USER_ID;
} else {
    // Local development
    console.log("Attempting to load config.json...");
    try {
        const config = require("./config.json");
        token = config.token;
        targetUserId = config.targetUserId;
        console.log("Successfully loaded config.json");
    } catch (error) {
        console.error("Environment variables not set and config.json not found!");
        console.error("Please set DISCORD_TOKEN and TARGET_USER_ID environment variables.");
        console.error("Error details:", error.message);
        process.exit(1);
    }
}

// Bot state
let botEnabled = true;
let disciplineMode = false;

// Function to update bot status
function updateBotStatus() {
    if (botEnabled) {
        client.user.setActivity('👁️ Watching Karl', { type: ActivityType.Custom });
        client.user.setStatus('online');
    } else {
        client.user.setActivity('😴 Sleeping', { type: ActivityType.Custom });
        client.user.setStatus('idle');
    }
    console.log(`Bot status updated: ${botEnabled ? 'MONITORING (Online)' : 'DISABLED (Idle)'}`);
}

// Function to check if target user is currently deafened in any voice channel
async function checkTargetUserDeafened() {
    try {
        // Get all guilds the bot is in
        for (const [guildId, guild] of client.guilds.cache) {
            // Find the target user's voice state in this guild
            const voiceState = guild.voiceStates.cache.get(targetUserId);
            
            if (voiceState && voiceState.channel && voiceState.selfDeaf) {
                console.log(`Found target user ${voiceState.member.user.tag} deafened in ${voiceState.channel.name} when bot was enabled`);
                
                if (disciplineMode) {
                    // Start discipline mode instead of kicking
                    startDisciplineMode(voiceState);
                } else {
                    // Kick them from the voice channel
                    voiceState.member.voice.disconnect('Auto-kicked for being deafened when bot was enabled')
                        .then(() => {
                            console.log(`Successfully kicked ${voiceState.member.user.tag} from voice channel (was deafened when enabled)`);
                        })
                        .catch(error => {
                            console.error(`Failed to kick user: ${error.message}`);
                        });
                }
                
                return true; // Found and handled
            }
        }
        console.log('Target user not found deafened in any voice channels');
        return false;
    } catch (error) {
        console.error('Error checking target user voice state:', error);
        return false;
    }
}

// Function to find empty voice channels in a guild, excluding a specific channel
function findEmptyVoiceChannels(guild, excludeChannelId = null) {
    const botMember = guild.members.me;
    if (!botMember) return new Map();
    
    return guild.channels.cache.filter(channel => {
        // Must be a voice channel
        if (channel.type !== 2) return false;
        
        // Don't include the excluded channel (usually current channel)
        if (excludeChannelId && channel.id === excludeChannelId) return false;
        
        // Must be empty (no members)
        if (channel.members.size > 0) return false;
        
        // Bot must be able to connect to the channel
        const permissions = channel.permissionsFor(botMember);
        if (!permissions) return false;
        
        // Check for required permissions
        return permissions.has(['Connect', 'MoveMembers', 'ViewChannel']);
    });
}

// Function to start discipline mode - rapidly move user between empty VCs
async function startDisciplineMode(voiceState) {
    const guild = voiceState.guild;
    const member = voiceState.member;
    const originalChannel = voiceState.channel; // Remember where they deafened
    const emptyChannels = findEmptyVoiceChannels(guild, originalChannel.id); // Exclude their current channel
    
    if (emptyChannels.size === 0) {
        console.log('No empty voice channels available for discipline mode (excluding current), kicking instead');
        member.voice.disconnect('Auto-kicked for deafening (no empty channels for discipline)')
            .catch(error => console.error(`Failed to kick user: ${error.message}`));
        return;
    }
    
    console.log(`Starting infinite discipline mode for ${member.user.tag} - found ${emptyChannels.size} empty channels`);
    console.log(`Original channel: ${originalChannel.name} - will return here when undeafened`);
    console.log(`Available channels: ${Array.from(emptyChannels.values()).map(c => c.name).join(', ')}`);
    
    const channelArray = Array.from(emptyChannels.values());
    let moveCount = 0;
    let moveInterval = 750; // Start at 0.75 seconds between moves
    let rateLimitHits = 0;
    
    let disciplineInterval;
    
    const runDiscipline = () => {
        disciplineInterval = setInterval(async () => {
            try {
                // Check if user left voice entirely (multiple ways to verify)
                if (!member.voice || !member.voice.channel || !member.voice.channelId) {
                    console.log('User left voice entirely, stopping discipline');
                    clearInterval(disciplineInterval);
                    return;
                }
                
                // Double-check user is still in a voice channel by fetching fresh voice state
                const freshVoiceState = member.guild.voiceStates.cache.get(member.id);
                if (!freshVoiceState || !freshVoiceState.channel) {
                    console.log('User no longer in voice (fresh check), stopping discipline');
                    clearInterval(disciplineInterval);
                    return;
                }
                
                // Check if user undeafened - if so, move them back and stop
                if (!member.voice.selfDeaf) {
                    console.log(`User undeafened! Moving ${member.user.tag} back to ${originalChannel.name}`);
                    clearInterval(disciplineInterval);
                    
                    // Move them back to original channel
                    try {
                        await member.voice.setChannel(originalChannel, 'Returned to original channel after undeafening');
                        console.log(`Successfully returned ${member.user.tag} to ${originalChannel.name}`);
                    } catch (error) {
                        console.error(`Failed to return user to original channel: ${error.message}`);
                        // If we can't move them back, just leave them where they are
                    }
                    return;
                }
                
                // Get fresh list of empty channels, excluding their current one
                const currentChannelId = member.voice.channel?.id;
                const freshEmptyChannels = findEmptyVoiceChannels(guild, currentChannelId);
                
                if (freshEmptyChannels.size === 0) {
                    console.log('No valid channels available (all occupied or current channel), ending discipline and kicking');
                    clearInterval(disciplineInterval);
                    member.voice.disconnect('Discipline ended - no valid channels available')
                        .catch(error => console.error(`Failed to kick user: ${error.message}`));
                    return;
                }
                
                // Convert to array and pick random channel
                const freshChannelArray = Array.from(freshEmptyChannels.values());
                const randomChannel = freshChannelArray[Math.floor(Math.random() * freshChannelArray.length)];
                
                // Double-check this isn't their current channel (should be impossible now)
                if (randomChannel.id === currentChannelId) {
                    console.log(`Somehow picked current channel ${randomChannel.name}, skipping move`);
                    return;
                }
                
                console.log(`Current: ${member.voice.channel?.name}, Moving to: ${randomChannel.name} (interval: ${moveInterval}ms)`);
                
                // Double-check permissions before attempting move
                const permissions = randomChannel.permissionsFor(guild.members.me);
                if (!permissions?.has(['Connect', 'MoveMembers', 'ViewChannel'])) {
                    console.log(`Missing permissions for ${randomChannel.name}, trying next move`);
                    return;
                }
                
                // Double-check channel is still empty right before move
                await randomChannel.fetch(); // Refresh channel data
                if (randomChannel.members.size > 0) {
                    console.log(`Channel ${randomChannel.name} is no longer empty (${randomChannel.members.size} members), trying next move`);
                    return;
                }
                
                // Store current position before move to verify success
                const beforeChannelId = member.voice.channelId;
                
                await member.voice.setChannel(randomChannel, 'Discipline mode - user was deafened');
                
                // Verify the move actually worked by checking their new position
                await new Promise(resolve => setTimeout(resolve, 100)); // Small delay for Discord to update
                const afterChannelId = member.voice.channelId;
                
                if (afterChannelId === randomChannel.id) {
                    moveCount++;
                    rateLimitHits = Math.max(0, rateLimitHits - 1); // Reduce rate limit counter on success
                    console.log(`Discipline move ${moveCount}: Successfully moved ${member.user.tag} to ${randomChannel.name}`);
                } else {
                    console.log(`Move failed: ${member.user.tag} is still in ${member.voice.channel?.name} instead of ${randomChannel.name}`);
                    console.log(`Before: ${beforeChannelId}, Target: ${randomChannel.id}, After: ${afterChannelId}`);
                }
                
            } catch (error) {
                console.error('Error during discipline mode:', error);
                console.log('Error details:', {
                    channelId: error.requestBody?.json?.channel_id,
                    code: error.code,
                    message: error.message
                });
                
                // Handle specific Discord API errors
                if (error.code === 50013) {
                    console.log('Permission error - falling back to kick');
                    clearInterval(disciplineInterval);
                    member.voice.disconnect('Auto-kicked due to permission error during discipline')
                        .catch(kickError => console.error(`Failed to kick user: ${kickError.message}`));
                } else if (error.code === 40032) {
                    console.log('Target user is not connected to voice - stopping discipline');
                    clearInterval(disciplineInterval);
                    // No need to kick since they're already gone
                } else if (error.status === 429) {
                    // Rate limited - increase interval and restart with slower timing
                    rateLimitHits++;
                    moveInterval = Math.min(moveInterval * 1.5, 5000); // Increase up to 5 seconds max
                    console.log(`Hit rate limit (${rateLimitHits} times) - slowing down to ${moveInterval}ms interval`);
                    clearInterval(disciplineInterval);
                    setTimeout(runDiscipline, 1000); // Wait 1 second then restart with new interval
                } else {
                    console.log('Unknown error during discipline - stopping');
                    clearInterval(disciplineInterval);
                }
            }
        }, moveInterval);
    };
    
    // Start the discipline loop
    runDiscipline();
}

// Create HTTP server for Railway health checks
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Discord bot is running!');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
});

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ] 
});

// Register slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('wk')
        .setDescription('Control the voice kick bot')
        .addStringOption(option =>
            option.setName('action')
                .setDescription('Turn the bot on/off, check status, or enable discipline mode')
                .setRequired(true)
                .addChoices(
                    { name: 'on', value: 'on' },
                    { name: 'off', value: 'off' },
                    { name: 'check', value: 'check' },
                    { name: 'discipline', value: 'discipline' }
                ))
];

// Bot ready event
client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log(`Monitoring voice channels for user ID: ${targetUserId}`);
    console.log(`Bot status: ${botEnabled ? 'ENABLED' : 'DISABLED'}`);
    
    // Set initial bot status
    updateBotStatus();
    
    // Register slash commands
    const rest = new REST().setToken(token);
    
    try {
        console.log('Started refreshing application (/) commands.');
        
        const data = await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        
        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
        console.log('Commands registered:', data.map(cmd => cmd.name));
    } catch (error) {
        console.error('Error registering slash commands:', error);
        console.error('Error details:', error.code, error.message);
    }
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    console.log(`Received interaction: ${interaction.type} - ${interaction.commandName}`);
    
    if (!interaction.isChatInputCommand()) return;
    
    if (interaction.commandName === 'wk') {
        console.log(`/wk command used by ${interaction.user.tag} (${interaction.user.id})`);
        
        // Check if the user is the target user (prevent them from using the command)
        if (interaction.user.id === targetUserId) {
            console.log(`Target user ${interaction.user.tag} tried to use /wk command - blocking`);
            await interaction.reply({ 
                content: '🚫 You cannot control this bot!'
            });
            return;
        }
        
        const action = interaction.options.getString('action');
        console.log(`Action: ${action}`);
        
        if (action === 'on') {
            if (botEnabled) {
                await interaction.reply({ 
                    content: '⚠️ Voice kick bot is already **ENABLED**!'
                });
            } else {
                botEnabled = true;
                updateBotStatus();
                
                // Check if target user is already deafened when bot is enabled
                const wasDeafened = await checkTargetUserDeafened();
                
                if (wasDeafened) {
                    await interaction.reply({ 
                        content: '✅ Voice kick bot is now **ENABLED**\n🦵 Target user was already deafened and has been kicked!'
                    });
                } else {
                    await interaction.reply({ 
                        content: '✅ Voice kick bot is now **ENABLED**'
                    });
                }
                console.log(`Bot enabled by ${interaction.user.tag}`);
            }
        } else if (action === 'off') {
            if (!botEnabled) {
                await interaction.reply({ 
                    content: '⚠️ Voice kick bot is already **DISABLED**!'
                });
            } else {
                botEnabled = false;
                updateBotStatus();
                await interaction.reply({ 
                    content: '🛑 Voice kick bot is now **DISABLED**'
                });
                console.log(`Bot disabled by ${interaction.user.tag}`);
            }
        } else if (action === 'check') {
            const status = botEnabled ? '**ENABLED** ✅' : '**DISABLED** 🛑';
            const mode = disciplineMode ? '**DISCIPLINE** 🌪️' : '**KICK** 🦵';
            const targetUser = await client.users.fetch(targetUserId).catch(() => null);
            const targetName = targetUser ? `${targetUser.tag}` : `User ID: ${targetUserId}`;
            
            await interaction.reply({ 
                content: `📊 **Bot Status:** ${status}\n⚡ **Mode:** ${mode}\n👤 **Target User:** ${targetName}`
            });
            console.log(`Status checked by ${interaction.user.tag}`);
        } else if (action === 'discipline') {
            if (!botEnabled) {
                await interaction.reply({ 
                    content: '⚠️ Bot must be enabled first! Use `/wk on` then `/wk discipline`'
                });
            } else if (disciplineMode) {
                disciplineMode = false;
                await interaction.reply({ 
                    content: '🦵 Discipline mode **DISABLED** - back to kicking mode'
                });
                console.log(`Discipline mode disabled by ${interaction.user.tag}`);
            } else {
                disciplineMode = true;
                await interaction.reply({ 
                    content: '🌪️ Discipline mode **ENABLED** - will move user between empty channels!'
                });
                console.log(`Discipline mode enabled by ${interaction.user.tag}`);
            }
        }
    }
});

// Voice state update event - triggers when someone joins/leaves/updates voice channel --
client.on('voiceStateUpdate', (oldState, newState) => {
    // Check if bot is disabled
    if (!botEnabled) return;
    
    // Check if the state change is for our target user
    if (newState.member.id !== targetUserId) return;
    
    // Check if the user is in a voice channel
    if (!newState.channel) return;
    
    // Check if user just joined and is already deafened
    if (!oldState.channel && newState.channel && newState.selfDeaf) {
        console.log(`Target user ${newState.member.user.tag} joined ${newState.channel.name} while already deafened`);
        
        if (disciplineMode) {
            // Start discipline mode
            startDisciplineMode(newState);
        } else {
            // Kick them from the voice channel
            newState.member.voice.disconnect('Auto-kicked for joining while deafened')
                .then(() => {
                    console.log(`Successfully kicked ${newState.member.user.tag} from voice channel (joined deafened)`);
                })
                .catch(error => {
                    console.error(`Failed to kick user: ${error.message}`);
                });
        }
        return;
    }
    
    // Check if the user just deafened themselves (original functionality)
    if (!oldState.selfDeaf && newState.selfDeaf) {
        console.log(`Target user ${newState.member.user.tag} has deafened themselves in ${newState.channel.name}`);
        
        if (disciplineMode) {
            // Start discipline mode
            startDisciplineMode(newState);
        } else {
            // Kick them from the voice channel
            newState.member.voice.disconnect('Auto-kicked for deafening')
                .then(() => {
                    console.log(`Successfully kicked ${newState.member.user.tag} from voice channel (deafened)`);
                })
                .catch(error => {
                    console.error(`Failed to kick user: ${error.message}`);
                });
        }
    }
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

client.login(token);
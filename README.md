# Karl Bot - Discord Voice Channel Monitor

A Discord bot that monitors voice channels for a specific user and kicks them when they deafen themselves.

## Features
- Monitors voice state changes for a target user
- Automatically kicks the user when they deafen themselves
- Console logging for monitoring activity
- Error handling for failed operations

## Local Development
1. Install dependencies: `npm install`
2. Configure your bot token and target user ID in `config.json`
3. Run the bot: `npm start`

## Deployment to Railway
1. Push this code to a GitHub repository
2. Connect Railway to your GitHub repo
3. Set environment variables:
   - `DISCORD_TOKEN`: Your bot's token
   - `TARGET_USER_ID`: The user ID to monitor
4. Deploy!

## Required Bot Permissions
- Connect (to see voice channel states)
- Move Members (to kick users from voice channels)
- View Channels (to see the voice channels)

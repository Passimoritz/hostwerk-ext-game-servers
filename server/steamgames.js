'use strict';
/*
 * Ready-made start profiles for popular Steam dedicated servers (SteamCMD method).
 *
 * One entry per Steam app id of the server tool. Everything a profile knows is built from a few values the user can change
 * (port, max players, name, password) – no download links, no version numbers, nothing that goes stale: installing and
 * updating is always "steamcmd +app_update <appid>". Games without a profile still work with a custom start command.
 *
 *   win / linux   program inside the server folder (null = the server tool does not exist for that system)
 *   args(v)       start parameters as an ARRAY (never a shell string) – v = { name, port, maxPlayers, password, secret, dir, platform }
 *   ports(p)      ports for forwarding, the Steam query and the firewall
 *   fields        which of name/port/maxPlayers/password the start parameters really use (the rest lives in the game's config file)
 *   configs       config files (relative to the server folder) for the editor – per system
 *   saves         folder with the world/saves for backups (relative); null = the game keeps them outside the server folder
 *   rcon          console input through Source RCON: { port(v) } (password = v.secret)
 *   stop          RCON command that saves and ends the server (graceful stop)
 *   log           log file the game writes itself (relative) – shown in the console tab next to the captured output
 *   libs          folders for LD_LIBRARY_PATH on Linux; env = extra environment variables
 *   login         true = the server tool needs a Steam account that owns the game (anonymous login is not possible)
 */

const U = 'UDP';
const T = 'TCP';
const TU = 'TCP/UDP';
const pw = (v, flag) => (v.password ? [flag, v.password] : []);
const pwEq = (v, flag) => (v.password ? [`${flag}${v.password}`] : []);

/** Source engine (srcds) servers share their start line – only the game folder and the first map differ. */
function srcds(name, game, gameDir, map, extra = {}) {
  return {
    name, game, win: 'srcds.exe', linux: 'srcds_run', port: 27015, maxPlayers: 16,
    fields: ['name', 'port', 'maxPlayers', 'password'],
    args: (v) => ['-console', '-game', gameDir, '-port', String(v.port), '+maxplayers', String(v.maxPlayers), '+map', map, '+hostname', v.name, '+rcon_password', v.secret, ...pw(v, '+sv_password')],
    ports: (p) => [{ name: 'Game', port: p, proto: TU }],
    configs: [`${gameDir}/cfg/server.cfg`],
    saves: `${gameDir}/cfg`,
    rcon: { port: (v) => v.port },
    stop: 'quit',
    ...extra,
  };
}

const PROFILES = {
  896660: {
    name: 'Valheim', game: 892970, win: 'valheim_server.exe', linux: 'valheim_server.x86_64', port: 2456, maxPlayers: 10,
    fields: ['name', 'port', 'password'], passwordMin: 5,
    env: { SteamAppId: '892970' }, libs: ['linux64'],
    args: (v) => ['-nographics', '-batchmode', '-name', v.name, '-port', String(v.port), '-world', 'Dedicated', ...pw(v, '-password'), '-public', '1', '-savedir', 'saves'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: p + 1, proto: U }],
    saves: 'saves', configs: ['saves/adminlist.txt', 'saves/permittedlist.txt', 'saves/bannedlist.txt'],
  },
  2394010: {
    name: 'Palworld', game: 1623730, win: 'PalServer.exe', linux: 'PalServer.sh', port: 8211, maxPlayers: 32,
    fields: ['port', 'maxPlayers'],
    args: (v) => [`-port=${v.port}`, `-players=${v.maxPlayers}`, '-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: 27015, proto: U }],
    configs: { windows: ['Pal/Saved/Config/WindowsServer/PalWorldSettings.ini', 'DefaultPalWorldSettings.ini'], linux: ['Pal/Saved/Config/LinuxServer/PalWorldSettings.ini', 'DefaultPalWorldSettings.ini'] },
    saves: 'Pal/Saved',
    note: 'Server name, password and RCON are set in PalWorldSettings.ini (copy the line from DefaultPalWorldSettings.ini after the first start).',
  },
  1690800: {
    name: 'Satisfactory', game: 526870, win: 'FactoryServer.exe', linux: 'FactoryServer.sh', port: 7777, maxPlayers: 4,
    fields: ['port'],
    args: (v) => [`-Port=${v.port}`, '-log', '-unattended'],
    ports: (p) => [{ name: 'Game', port: p, proto: TU }, { name: 'Messaging', port: 8888, proto: T }],
    saves: null, configs: { windows: ['FactoryGame/Saved/Config/WindowsServer/Game.ini'], linux: ['FactoryGame/Saved/Config/LinuxServer/Game.ini'] },
    note: 'Name, password and the world are set up when you first connect from the game (Server Manager).',
  },
  2430930: {
    name: 'ARK: Survival Ascended', game: 2399830, win: 'ShooterGame/Binaries/Win64/ArkAscendedServer.exe', linux: null, port: 7777, maxPlayers: 70,
    fields: ['name', 'port', 'maxPlayers', 'password'],
    args: (v) => [`TheIsland_WP?listen?SessionName=${v.name}?Port=${v.port}?RCONEnabled=True?RCONPort=27020?ServerAdminPassword=${v.secret}${v.password ? `?ServerPassword=${v.password}` : ''}`, `-WinLiveMaxPlayers=${v.maxPlayers}`, '-log'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'RCON', port: 27020, proto: T }],
    saves: 'ShooterGame/Saved', configs: ['ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini', 'ShooterGame/Saved/Config/WindowsServer/Game.ini'],
    rcon: { port: () => 27020 }, stop: 'DoExit', urlArgs: true,
  },
  376030: {
    name: 'ARK: Survival Evolved', game: 346110, win: 'ShooterGame/Binaries/Win64/ShooterGameServer.exe', linux: 'ShooterGame/Binaries/Linux/ShooterGameServer', port: 7777, maxPlayers: 70,
    fields: ['name', 'port', 'maxPlayers', 'password'],
    args: (v) => [`TheIsland?listen?SessionName=${v.name}?Port=${v.port}?QueryPort=27015?MaxPlayers=${v.maxPlayers}?RCONEnabled=True?RCONPort=27020?ServerAdminPassword=${v.secret}${v.password ? `?ServerPassword=${v.password}` : ''}`, '-server', '-log'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Raw', port: p + 1, proto: U }, { name: 'Query', port: 27015, proto: U }, { name: 'RCON', port: 27020, proto: T }],
    saves: 'ShooterGame/Saved', configs: { windows: ['ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini'], linux: ['ShooterGame/Saved/Config/LinuxServer/GameUserSettings.ini'] },
    rcon: { port: () => 27020 }, stop: 'DoExit', urlArgs: true,
  },
  294420: {
    name: '7 Days to Die', game: 251570, win: '7DaysToDieServer.exe', linux: '7DaysToDieServer.x86_64', port: 26900, maxPlayers: 8,
    fields: [], libs: ['.'],
    args: () => ['-quit', '-batchmode', '-nographics', '-configfile=serverconfig.xml', '-dedicated'],
    ports: (p) => [{ name: 'Game', port: p, proto: TU }, { name: 'Game 2', port: p + 1, proto: U }, { name: 'Game 3', port: p + 2, proto: U }],
    configs: ['serverconfig.xml'], saves: null,
    note: 'Name, password, port and slots are in serverconfig.xml (ServerName, ServerPassword, ServerPort, ServerMaxPlayerCount).',
  },
  380870: {
    name: 'Project Zomboid', game: 108600, win: 'StartServer64.bat', linux: 'start-server.sh', port: 16261, maxPlayers: 16,
    fields: [],
    args: (v) => ['-servername', 'hostwerk', '-adminpassword', v.secret],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Direct', port: p + 1, proto: U }],
    saves: null, configs: [],
    note: 'Settings are in Zomboid/Server/hostwerk.ini in your user folder. The admin password is shown below.',
  },
  258550: {
    name: 'Rust', game: 252490, win: 'RustDedicated.exe', linux: 'RustDedicated', port: 28015, maxPlayers: 50,
    fields: ['name', 'port', 'maxPlayers'], libs: ['RustDedicated_Data/Plugins/x86_64'],
    args: (v) => ['-batchmode', '-nographics', '+server.port', String(v.port), '+server.queryport', String(v.port + 2), '+rcon.port', String(v.port + 1), '+rcon.web', '0', '+rcon.password', v.secret,
      '+server.hostname', v.name, '+server.maxplayers', String(v.maxPlayers), '+server.identity', 'hostwerk', '+server.worldsize', '3000', '+server.seed', '12345'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'RCON', port: p + 1, proto: T }, { name: 'Query', port: p + 2, proto: U }],
    saves: 'server/hostwerk', configs: ['server/hostwerk/cfg/server.cfg', 'server/hostwerk/cfg/users.cfg'],
    rcon: { port: (v) => v.port + 1 }, stop: 'quit',
  },
  730: srcds('Counter-Strike 2', 730, 'csgo', 'de_dust2', {
    win: 'game/bin/win64/cs2.exe', linux: 'game/bin/linuxsteamrt64/cs2',
    args: (v) => ['-dedicated', '-console', '-usercon', '-port', String(v.port), '-maxplayers', String(v.maxPlayers), '+game_type', '0', '+game_mode', '1', '+map', 'de_dust2', '+hostname', v.name, '+rcon_password', v.secret, ...pw(v, '+sv_password')],
    configs: ['game/csgo/cfg/server.cfg'], saves: 'game/csgo/cfg',
    note: 'For a server in the public list you need a Game Server Login Token (+sv_setsteamaccount) – add it under extra parameters.',
  }),
  4020: srcds("Garry's Mod", 4000, 'garrysmod', 'gm_construct'),
  232250: srcds('Team Fortress 2', 440, 'tf', 'ctf_2fort'),
  222860: srcds('Left 4 Dead 2', 550, 'left4dead2', 'c1m1_hotel'),
  222840: srcds('Left 4 Dead', 500, 'left4dead', 'l4d_hospital01_apartment'),
  232330: srcds('Counter-Strike: Source', 240, 'cstrike', 'de_dust2'),
  232370: srcds('Half-Life 2: Deathmatch', 320, 'hl2mp', 'dm_lockdown'),
  232290: srcds('Day of Defeat: Source', 300, 'dod', 'dod_anzio'),
  317670: srcds('No More Room in Hell', 224260, 'nmrih', 'nmo_broadway'),
  295230: srcds('Fistful of Frags', 265630, 'fof', 'fof_fistful'),
  1829350: {
    name: 'V Rising', game: 1604030, win: 'VRisingServer.exe', linux: null, port: 9876, maxPlayers: 40,
    fields: ['name'],
    args: (v) => ['-persistentDataPath', 'save-data', '-serverName', v.name, '-saveName', 'world1', '-logFile', 'logs/VRisingServer.log'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: p + 1, proto: U }],
    saves: 'save-data', configs: ['save-data/Settings/ServerHostSettings.json', 'save-data/Settings/ServerGameSettings.json'], log: 'logs/VRisingServer.log',
    note: 'Ports, password and slots are in ServerHostSettings.json (copy it from VRisingServer_Data/StreamingAssets/Settings after the first start).',
  },
  2278520: {
    name: 'Enshrouded', game: 1203620, win: 'enshrouded_server.exe', linux: null, port: 15636, maxPlayers: 16,
    fields: [],
    args: () => [],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: p + 1, proto: U }],
    saves: 'savegame', configs: ['enshrouded_server.json'], log: 'logs/enshrouded_server.log',
    note: 'Name, password, ports and slots are in enshrouded_server.json (created on the first start).',
  },
  443030: {
    name: 'Conan Exiles', game: 440900, win: 'ConanSandboxServer.exe', linux: null, port: 7777, maxPlayers: 40,
    fields: ['port', 'maxPlayers'],
    args: (v) => ['-log', `-MaxPlayers=${v.maxPlayers}`, `-Port=${v.port}`, '-QueryPort=27015'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Raw', port: p + 1, proto: U }, { name: 'Query', port: 27015, proto: U }],
    saves: 'ConanSandbox/Saved', configs: ['ConanSandbox/Saved/Config/WindowsServer/ServerSettings.ini', 'ConanSandbox/Saved/Config/WindowsServer/Engine.ini'],
    note: 'Server name and password are in Engine.ini / ServerSettings.ini.',
  },
  298740: {
    name: 'Space Engineers', game: 244850, win: 'DedicatedServer64/SpaceEngineersDedicated.exe', linux: null, port: 27016, maxPlayers: 8,
    fields: [],
    args: () => ['-console'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }],
    saves: null, configs: [],
    note: 'Space Engineers needs a world set up once (SpaceEngineers-Dedicated.cfg in AppData\\Roaming\\SpaceEngineersDedicated) – see the guide.',
  },
  1110390: {
    name: 'Unturned', game: 304930, win: 'Unturned.exe', linux: 'Unturned_Headless.x86_64', port: 27015, maxPlayers: 24,
    fields: [],
    args: () => ['-batchmode', '-nographics', '+InternetServer/hostwerk'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: p + 1, proto: U }],
    saves: 'Servers/hostwerk', configs: ['Servers/hostwerk/Server/Commands.dat', 'Servers/hostwerk/Config.json'],
    note: 'Name, port, password and slots are set in Servers/hostwerk/Server/Commands.dat (Name, Port, Password, MaxPlayers).',
  },
  343050: {
    name: "Don't Starve Together", game: 322330, win: 'bin64/dontstarve_dedicated_server_nullrenderer_x64.exe', linux: 'bin64/dontstarve_dedicated_server_nullrenderer_x64', cwd: 'bin64', port: 10999, maxPlayers: 6,
    fields: [],
    args: (v) => ['-persistent_storage_root', v.dir, '-conf_dir', 'DSTData', '-cluster', 'Cluster_1', '-shard', 'Master'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }],
    saves: 'DSTData', configs: ['DSTData/Cluster_1/cluster.ini', 'DSTData/Cluster_1/cluster_token.txt'],
    note: 'Needs a cluster token from Klei (cluster_token.txt) – see the guide.',
  },
  232130: {
    name: 'Killing Floor 2', game: 232090, win: 'Binaries/Win64/KFServer.exe', linux: 'Binaries/Win64/KFGameSteamServer.bin.x86_64', port: 7777, maxPlayers: 6,
    fields: ['port', 'maxPlayers', 'password'],
    args: (v) => [`KF-BioticsLab?MaxPlayers=${v.maxPlayers}${v.password ? `?GamePassword=${v.password}` : ''}`, `-Port=${v.port}`],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: 27015, proto: U }, { name: 'Web admin', port: 8080, proto: T }],
    saves: null, configs: { windows: ['KFGame/Config/PCServer-KFGame.ini'], linux: ['KFGame/Config/LinuxServer-KFGame.ini'] }, urlArgs: true,
  },
  403240: {
    name: 'Squad', game: 393380, win: 'SquadGameServer.exe', linux: 'SquadGameServer.sh', port: 7787, maxPlayers: 80,
    fields: ['port', 'maxPlayers'],
    args: (v) => [`Port=${v.port}`, 'QueryPort=27165', `FIXEDMAXPLAYERS=${v.maxPlayers}`, 'RANDOM=NONE', '-log'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Game 2', port: p + 1, proto: U }, { name: 'Query', port: 27165, proto: U }],
    saves: null, configs: ['SquadGame/ServerConfig/Server.cfg', 'SquadGame/ServerConfig/Admins.cfg'],
  },
  581330: {
    name: 'Insurgency: Sandstorm', game: 581320, win: 'Insurgency/Binaries/Win64/InsurgencyServer-Win64-Shipping.exe', linux: 'Insurgency/Binaries/Linux/InsurgencyServer-Linux-Shipping', port: 27102, maxPlayers: 28,
    fields: ['name', 'port', 'maxPlayers', 'password'],
    args: (v) => [`Oilfield?Scenario=Scenario_Refinery_Push_Security?MaxPlayers=${v.maxPlayers}${v.password ? `?Password=${v.password}` : ''}`, `-Port=${v.port}`, '-QueryPort=27131', `-hostname=${v.name}`, '-log'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: 27131, proto: U }],
    saves: null, configs: [], urlArgs: true,
    note: 'For the public list Sandstorm needs a Game Server Login Token (-GSLTToken=…) – add it under extra parameters.',
  },
  556450: {
    name: 'The Forest', game: 242760, win: 'TheForestDedicatedServer.exe', linux: null, port: 27015, maxPlayers: 8,
    fields: ['name', 'port', 'maxPlayers', 'password'],
    args: (v) => ['-serverip', '0.0.0.0', '-serversteamport', '8766', '-servergameport', String(v.port), '-serverqueryport', String(v.port + 1), '-servername', v.name, '-serverplayers', String(v.maxPlayers), ...pw(v, '-serverpassword'), '-batchmode', '-nographics'],
    ports: (p) => [{ name: 'Steam', port: 8766, proto: U }, { name: 'Game', port: p, proto: U }, { name: 'Query', port: p + 1, proto: U }],
    saves: null, configs: [],
  },
  2465200: {
    name: 'Sons of the Forest', game: 1326470, win: 'SonsOfTheForestDS.exe', linux: null, port: 8766, maxPlayers: 8,
    fields: [],
    args: () => ['-userdatapath', 'userdata'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: 27016, proto: U }, { name: 'Blob sync', port: 9700, proto: U }],
    saves: 'userdata', configs: ['userdata/dedicatedserver.cfg'],
    note: 'Name, password and slots are in userdata/dedicatedserver.cfg (created on the first start).',
  },
  2089300: {
    name: 'Icarus', game: 1149460, win: 'IcarusServer.exe', linux: null, port: 17777, maxPlayers: 8,
    fields: ['name', 'port'],
    args: (v) => [`-SteamServerName=${v.name}`, `-PORT=${v.port}`, '-QueryPort=27015', '-log'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: 27015, proto: U }],
    saves: 'Icarus/Saved', configs: ['Icarus/Saved/Config/WindowsServer/ServerSettings.ini'],
  },
  2857200: {
    name: 'Abiotic Factor', game: 427410, win: 'AbioticFactor/Binaries/Win64/AbioticFactorServer-Win64-Shipping.exe', linux: null, port: 7777, maxPlayers: 6,
    fields: ['name', 'port', 'maxPlayers', 'password'],
    args: (v) => ['-log', '-useperfthreads', '-NoAsyncLoadingThread', `-MaxServerPlayers=${v.maxPlayers}`, `-PORT=${v.port}`, '-QueryPort=27015', `-SteamServerName=${v.name}`, ...pwEq(v, '-ServerPassword=')],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: 27015, proto: U }],
    saves: 'AbioticFactor/Saved', configs: [],
  },
  1963720: {
    name: 'Core Keeper', game: 1621690, win: 'CoreKeeperServer.exe', linux: '_launch.sh', port: 0, maxPlayers: 8,
    fields: ['name', 'maxPlayers'],
    args: (v) => ['-batchmode', '-logfile', 'CoreKeeperServerLog.txt', '-worldname', v.name, '-maxplayers', String(v.maxPlayers)],
    ports: () => [],
    saves: null, configs: [], log: 'CoreKeeperServerLog.txt',
    note: 'Core Keeper connects through Steam with a Game ID (in the log) – no port forwarding needed. On Linux it needs xvfb.',
  },
  1026340: {
    name: 'Barotrauma', game: 602960, win: 'DedicatedServer.exe', linux: 'DedicatedServer', port: 27015, maxPlayers: 16,
    fields: [],
    args: () => [],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: p + 1, proto: U }],
    saves: null, configs: ['serversettings.xml'],
    note: 'Name, password, ports and slots are in serversettings.xml.',
  },
  629800: {
    name: 'Mordhau', game: 629760, win: 'MordhauServer.exe', linux: 'MordhauServer.sh', port: 7777, maxPlayers: 48,
    fields: ['port'],
    args: (v) => ['-log', `-Port=${v.port}`, '-QueryPort=27015', '-BeaconPort=15000'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: 27015, proto: U }, { name: 'Beacon', port: 15000, proto: U }],
    saves: null, configs: { windows: ['Mordhau/Saved/Config/WindowsServer/Game.ini'], linux: ['Mordhau/Saved/Config/LinuxServer/Game.ini'] },
  },
  1874900: {
    name: 'Arma Reforger', game: 1874880, win: 'ArmaReforgerServer.exe', linux: 'ArmaReforgerServer', port: 2001, maxPlayers: 64,
    fields: [],
    args: () => ['-config', 'config.json', '-profile', 'profile', '-maxFPS', '60'],
    ports: (p) => [{ name: 'Game', port: p, proto: U }, { name: 'Query', port: 17777, proto: U }],
    saves: 'profile', configs: ['config.json'],
    note: 'Arma Reforger needs a config.json in the server folder – the guide has an example.',
  },
  1948160: {
    name: 'Euro Truck Simulator 2', game: 227300, win: 'bin/win_x64/eurotrucks2_server.exe', linux: 'bin/linux_x64/eurotrucks2_server', port: 27015, maxPlayers: 8,
    fields: [],
    args: () => [],
    ports: (p) => [{ name: 'Game', port: p, proto: TU }, { name: 'Query', port: p + 1, proto: U }],
    saves: null, configs: [],
    note: 'Needs server_packages exported from the game (console: export_server_packages) – see the guide.',
  },
  2239530: {
    name: 'American Truck Simulator', game: 270880, win: 'bin/win_x64/amtrucks_server.exe', linux: 'bin/linux_x64/amtrucks_server', port: 27015, maxPlayers: 8,
    fields: [],
    args: () => [],
    ports: (p) => [{ name: 'Game', port: p, proto: TU }, { name: 'Query', port: p + 1, proto: U }],
    saves: null, configs: [],
    note: 'Needs server_packages exported from the game (console: export_server_packages) – see the guide.',
  },
  728470: {
    name: 'Astroneer', game: 361420, win: 'AstroServer.exe', linux: null, port: 8777, maxPlayers: 8,
    fields: [],
    args: () => [],
    ports: (p) => [{ name: 'Game', port: p, proto: U }],
    saves: 'Astro/Saved', configs: ['Astro/Saved/Config/WindowsServer/AstroServerSettings.ini', 'Astro/Saved/Config/WindowsServer/Engine.ini'],
  },
};

/*
 * More server tools Hostwerk knows by id (shown in the list even before the complete Steam list was loaded).
 * login = needs a Steam account that owns the game – Hostwerk only uses the anonymous login, so these can't be installed here.
 */
const KNOWN = [
  [600760, 'Stationeers Dedicated Server', 544550], [622970, 'Pavlov VR Dedicated Server', 555160], [405100, 'Hurtworld Dedicated Server', 393420],
  [412680, 'The Isle Dedicated Server', 376210], [4940, 'Natural Selection 2 Dedicated Server', 4920], [215360, 'Killing Floor Dedicated Server', 1250],
  [276060, 'Sven Co-op Dedicated Server', 225840], [346680, 'Black Mesa Dedicated Server', 362890], [237410, 'Insurgency Dedicated Server', 222880],
  [462310, 'Day of Infamy Dedicated Server', 447820], [220070, 'Chivalry: Medieval Warfare Dedicated Server', 219640], [367970, 'Medieval Engineers Dedicated Server', 333950],
  [418480, 'Rising Storm 2: Vietnam Dedicated Server', 418460], [1424230, 'Holdfast: Nations At War Dedicated Server', 589290], [3017300, 'Soulmask Dedicated Server', 2646460],
  [565060, 'Avorion Dedicated Server', 445220], [739590, 'Eco Dedicated Server', 382310], [530870, 'Empyrion - Galactic Survival Dedicated Server', 383120],
  [233780, 'Arma 3 Server', 107410, true], [223350, 'DayZ Server', 221100, true], [533830, 'Starbound Dedicated Server', 211820, true],
  [105600, 'Terraria (dedicated server in the game)', 105600, true],
];

const DEF_SECRET = () => require('crypto').randomBytes(8).toString('hex');

/** Profile for an app id (or null). */
function profileFor(appid) { return Object.prototype.hasOwnProperty.call(PROFILES, String(Number(appid))) ? PROFILES[Number(appid)] : null; }

/** The curated part of the app list: every profile plus the known ids. */
function curatedApps() {
  const out = [];
  for (const [id, p] of Object.entries(PROFILES)) out.push({ appid: Number(id), name: `${p.name} Dedicated Server`, game: p.game, win: !!p.win, linux: !!p.linux, profile: true, login: !!p.login });
  for (const [appid, name, game, login] of KNOWN) if (!out.some((x) => x.appid === appid)) out.push({ appid, name, game, win: null, linux: null, profile: false, login: !!login });
  return out;
}

/** Values the user may set – cleaned so they are safe inside start parameters (no quotes, no control characters). */
function cleanValues(raw, p, { url = false } = {}) {
  const strip = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f"`$\\]/g, '').replace(url ? /[?&=]/g : /$^/, '').trim().slice(0, max);
  const port = Number(raw.port);
  const maxPlayers = Number(raw.maxPlayers);
  return {
    name: strip(raw.name, 60) || 'Hostwerk',
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : (p && p.port) || 27015,
    maxPlayers: Number.isInteger(maxPlayers) && maxPlayers >= 1 && maxPlayers <= 1000 ? maxPlayers : (p && p.maxPlayers) || 16,
    password: strip(raw.password, 40).replace(/\s/g, ''),
    secret: /^[a-f0-9]{8,32}$/.test(String(raw.secret || '')) ? raw.secret : DEF_SECRET(),
    dir: String(raw.dir || ''),
    platform: raw.platform === 'linux' ? 'linux' : 'windows',
  };
}

/**
 * Split a custom parameter line into an argument list – quotes group, nothing is ever handed to a shell.
 * 'a "b c" d' → ['a', 'b c', 'd']
 */
function splitArgs(str) {
  const s = String(str || '');
  if (/[\u0000-\u0008\u000a-\u001f]/.test(s)) throw new Error('Control characters are not allowed in parameters.');
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  if (out.length > 80) throw new Error('Too many parameters (at most 80).');
  if (out.some((a) => a.length > 400)) throw new Error('A parameter is too long.');
  return out;
}

/** Start line of a server: profile args (or the custom line) + extra parameters. */
function buildArgs(s, platform, dir) {
  const p = profileFor(s.appid);
  const custom = s.custom && s.custom.args != null && String(s.custom.args).trim() !== '' ? splitArgs(s.custom.args) : null;
  const v = cleanValues({ ...s, dir, platform }, p, { url: !!(p && p.urlArgs) });
  const base = custom || (p ? p.args(v) : []);
  return [...base, ...splitArgs(s.extraArgs || '')];
}

/** Ports of a server (profile, custom list "2456/udp, 2457/udp" or nothing). */
function portsFor(s) {
  if (Array.isArray(s.customPorts) && s.customPorts.length) return s.customPorts;
  const p = profileFor(s.appid);
  if (!p) return [];
  const v = cleanValues(s, p);
  return p.ports(v.port);
}
/** "2456/udp, 2457/udp 27015" → [{ name, port, proto }] */
function parsePortList(str) {
  const out = [];
  for (const part of String(str || '').split(/[\s,;]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,5})(?:\/(tcp|udp|tcp\/udp|udp\/tcp|both))?$/i);
    if (!m) throw new Error(`Invalid port “${part.slice(0, 20)}” – write e.g. 2456/udp.`);
    const port = Number(m[1]);
    if (port < 1 || port > 65535) throw new Error(`Port ${port} is outside 1–65535.`);
    const proto = !m[2] ? 'UDP' : /both|\//i.test(m[2]) ? 'TCP/UDP' : m[2].toUpperCase();
    out.push({ name: out.length ? `Port ${out.length + 1}` : 'Game', port, proto });
  }
  return out.slice(0, 20);
}

/** Config files of a profile for one system. */
function configsFor(appid, platform) {
  const p = profileFor(appid);
  if (!p || !p.configs) return [];
  return Array.isArray(p.configs) ? p.configs : p.configs[platform] || [];
}

module.exports = { PROFILES, KNOWN, profileFor, curatedApps, cleanValues, splitArgs, buildArgs, portsFor, parsePortList, configsFor };

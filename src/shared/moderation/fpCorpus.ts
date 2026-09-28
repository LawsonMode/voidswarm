// OWNER: FILTER agent. TEST DATA: a large false-positive corpus for the chat / name filter — realistic, PG game chat
// and callsigns built from the game's own vocabulary (classes, skills, paths, talents, capital ships, turret kits,
// game types, sub-modes, objectives, house rooms, team colors, loot sets) plus common first names, US / Idaho place
// names, sports teams and PG trash talk. Every line must PASS the built-in lists (fpCorpus.test.ts). Only tests
// import this module; it never ships in the client bundle. Deterministic: no randomness, the same corpus every run.
import { GAME_TYPES, SUB_MODES } from '../data/gameTypes';
import { RARITY_NAMES, SET_INFO } from '../data/loot';
import { PATHS, SHIP_CLASSES, SHIP_CLASS_IDS } from '../data/ships';
import { TEAM_NAMES } from '../data/teams';
import { houseRooms } from '../room/houseRooms';
import { rot13 } from './lists';

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------------------

const classes = SHIP_CLASS_IDS.map((id) => SHIP_CLASSES[id]);
export const CLASS_NAMES = classes.map((c) => c.name);
const ARCHETYPES = classes.map((c) => c.archetype);
const SKILLS = classes.flatMap((c) => Object.values(c.skills).map((s) => s.name));
const TURRETS = classes.flatMap((c) => [c.turret.name, c.turret.offense.name, c.turret.defense.name]);
const CAPITALS = classes.map((c) => c.capital.name);
const CAPITAL_SKILLS = classes.map((c) => c.capital.skill.name);
const PATH_LIST = Object.values(PATHS);
const PATH_NAMES = PATH_LIST.map((p) => p.name);
const TALENT_NAMES = PATH_LIST.flatMap((p) => p.talents.map((t) => t.name));
const GAME_TYPE_NAMES = Object.values(GAME_TYPES).map((t) => t.name);
const SUB_MODE_NAMES = Object.values(SUB_MODES).flatMap((s) => [s.name, s.short]);
const ROOM_NAMES = [...new Set([...houseRooms(false), ...houseRooms(true)].map((r) => r.name ?? '').filter(Boolean)
  .concat(Object.values(GAME_TYPES).map((t) => t.houseName)))];
const SET_NAMES = Object.values(SET_INFO).flatMap((s) => [s.name, s.cacheName]);
/** Game text players quote back in chat: descriptions, taglines, blurbs, bullets. */
const GAME_TEXT = [
  ...classes.flatMap((c) => [c.description, c.role, c.capital.description, c.capital.skill.description, c.turret.offense.description,
    c.turret.defense.description, ...Object.values(c.skills).map((s) => s.description)]),
  ...PATH_LIST.flatMap((p) => [p.tagline, p.description, ...p.talents.map((t) => t.description)]),
  ...Object.values(GAME_TYPES).flatMap((t) => [t.tagline, t.playersLine, ...t.bullets]),
  ...Object.values(SUB_MODES).map((s) => s.blurb),
  ...Object.values(SET_INFO).map((s) => s.tagline),
];
const OBJECTIVES = ['the flag', 'our pennant', 'their pennant', 'the relay pad', 'pad A', 'pad B', 'pad C', 'the hot point', 'the zone',
  'the payload', 'the checkpoint', 'the Hive', 'the Matriarch', 'the boss', 'the extract gate', 'the stairs', 'the sealed room',
  'the treasure room', 'the cache', 'the crate', 'the spawn', 'mid', 'top lane', 'the left flank', 'the right side'];

/** Common US first names (a class roster), including names from many backgrounds. */
export const FIRST_NAMES = [
  'Liam', 'Noah', 'Oliver', 'Elijah', 'James', 'William', 'Benjamin', 'Lucas', 'Henry', 'Theodore', 'Jack', 'Levi',
  'Alexander', 'Jackson', 'Mateo', 'Daniel', 'Michael', 'Mason', 'Sebastian', 'Ethan', 'Logan', 'Owen', 'Samuel', 'Jacob',
  'Asher', 'Aiden', 'John', 'Joseph', 'Wyatt', 'David', 'Leo', 'Luke', 'Julian', 'Hudson', 'Grayson', 'Matthew', 'Ezra',
  'Gabriel', 'Carter', 'Isaac', 'Jayden', 'Luca', 'Anthony', 'Dylan', 'Lincoln', 'Thomas', 'Maverick', 'Elias', 'Josiah',
  'Charles', 'Caleb', 'Christopher', 'Ezekiel', 'Miles', 'Jaxon', 'Isaiah', 'Andrew', 'Joshua', 'Nathan', 'Nolan', 'Adrian',
  'Cameron', 'Santiago', 'Eli', 'Aaron', 'Ryan', 'Angel', 'Cooper', 'Waylon', 'Easton', 'Kai', 'Christian', 'Landon',
  'Colton', 'Roman', 'Axel', 'Brooks', 'Jonathan', 'Robert', 'Jameson', 'Ian', 'Everett', 'Wesley', 'Jeremiah', 'Hunter',
  'Jordan', 'Jose', 'Bennett', 'Silas', 'Nicholas', 'Parker', 'Beau', 'Weston', 'Austin', 'Connor', 'Carson', 'Dominic',
  'Xavier', 'Jace', 'Emmett', 'Adam', 'Declan', 'Rowan', 'Micah', 'Gael', 'River', 'Ryder', 'Sawyer', 'Evan', 'Vincent',
  'Harrison', 'August', 'Bryson', 'Amir', 'Giovanni', 'Chase', 'Diego', 'Milo', 'Jasper', 'Walker', 'Jason', 'Brayden',
  'Cole', 'Nathaniel', 'George', 'Lorenzo', 'Zion', 'Luis', 'Archer', 'Enzo', 'Jonah', 'Thiago', 'Theo', 'Zachary', 'Calvin',
  'Rhett', 'Atlas', 'Jude', 'Bentley', 'Carlos', 'Arthur', 'Tyler', 'Max', 'Elliot', 'Graham', 'Maxwell', 'Juan', 'Dean',
  'Malachi', 'Ivan', 'Gavin', 'Camden', 'Hayden', 'Leon', 'Antonio', 'Justin', 'Tucker', 'Brandon', 'Kevin', 'Judah',
  'Finn', 'Brody', 'Xander', 'Charlie', 'Arlo', 'Emmanuel', 'Abel', 'Kaleb', 'Caden', 'Titus', 'Cassius', 'Dashiell',
  'Olivia', 'Emma', 'Charlotte', 'Amelia', 'Sophia', 'Mia', 'Isabella', 'Ava', 'Evelyn', 'Luna', 'Harper', 'Camila',
  'Sofia', 'Scarlett', 'Elizabeth', 'Eleanor', 'Emily', 'Chloe', 'Mila', 'Violet', 'Penelope', 'Gianna', 'Aria', 'Abigail',
  'Ella', 'Avery', 'Hazel', 'Nora', 'Layla', 'Lily', 'Aurora', 'Nova', 'Ellie', 'Madison', 'Grace', 'Isla', 'Willow',
  'Zoe', 'Riley', 'Stella', 'Emilia', 'Victoria', 'Hannah', 'Addison', 'Leah', 'Lucy', 'Eliana', 'Ivy', 'Everly',
  'Lillian', 'Paisley', 'Elena', 'Naomi', 'Maya', 'Natalie', 'Kinsley', 'Delilah', 'Claire', 'Audrey', 'Aaliyah', 'Ruby',
  'Brooklyn', 'Alice', 'Aubrey', 'Autumn', 'Leilani', 'Savannah', 'Valentina', 'Kennedy', 'Madelyn', 'Josephine', 'Bella',
  'Skylar', 'Genesis', 'Sophie', 'Hailey', 'Sadie', 'Natalia', 'Quinn', 'Caroline', 'Allison', 'Gabriella', 'Anna',
  'Serenity', 'Nevaeh', 'Cora', 'Ariana', 'Emery', 'Lydia', 'Jade', 'Sarah', 'Eva', 'Adeline', 'Madeline', 'Piper',
  'Rylee', 'Athena', 'Peyton', 'Vivian', 'Clara', 'Liliana', 'Samantha', 'Maria', 'Iris', 'Ayla', 'Eloise', 'Lyla',
  'Eliza', 'Hadley', 'Melody', 'Julia', 'Rose', 'Isabelle', 'Brielle', 'Arya', 'Eden', 'Remi', 'Mackenzie', 'Maeve',
  'Margaret', 'Reagan', 'Melanie', 'Josie', 'Cecilia', 'Mary', 'Daisy', 'Lucia', 'Ximena', 'Juniper', 'Kaylee', 'Magnolia',
  'Summer', 'Sloane', 'Amara', 'Isabel', 'Reese', 'Sienna', 'Freya', 'Valerie', 'Genevieve', 'Esther', 'Katherine',
  'Kylie', 'Bailey', 'Ember', 'Georgia', 'Catalina', 'Emerson', 'Alexandra', 'Faith', 'Jasmine', 'Ashley', 'Andrea',
  'Millie', 'June', 'Callie', 'Sage', 'Ada', 'Anastasia', 'Olive', 'Brianna', 'Molly', 'Amy', 'Ruth', 'Aspen', 'Cassidy',
  'Cassandra', 'Vanessa', 'Shelby', 'Ashlyn', 'Jessica', 'Sasha', 'Tessa', 'Nessa', 'Marissa', 'Melissa', 'Alyssa',
  'Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Ishaan', 'Rohan', 'Siddharth', 'Priya', 'Ananya', 'Diya', 'Saanvi', 'Kavya',
  'Harshit', 'Harshita', 'Kshitij', 'Mohammed', 'Omar', 'Yusuf', 'Ali', 'Hassan', 'Fatima', 'Aisha', 'Zainab', 'Mariam',
  'Haruto', 'Hiroshi', 'Yuki', 'Sakura', 'Mei', 'Wei', 'Jun', 'Min', 'Linh', 'Anh', 'Bao', 'Kofi', 'Ama', 'Chidi',
  'Ngozi', 'Tunde', 'Jamal', 'Malik', 'Imani', 'Keisha', 'Tyrese', 'DeShawn', 'Alejandro', 'Joaquin', 'Esperanza',
  'Guadalupe', 'Dmitri', 'Sven', 'Ingrid', 'Bjorn', 'Siobhan', 'Niamh', 'Aoife', 'Keanu', 'Makoa',
  // names found in review (refused or starred before their allow words; several WITH A STRIKE once a number was added)
  'Kuntal', 'Analisa', 'Anusha', 'Anushka', 'Shital', 'Ashit', 'Ashita', 'Shitij', 'Juliana', 'Diana', 'Svetlana',
  'Makana', 'Deepak', 'Fukuda', 'Keith', 'Seth', 'Smith', 'Riddick',
];

/** US and Idaho place names. */
export const PLACES = [
  'Boise', 'Nampa', 'Meridian', 'Caldwell', 'Idaho Falls', 'Pocatello', 'Coeur d Alene', 'Twin Falls', 'Lewiston',
  'Post Falls', 'Rexburg', 'Eagle', 'Kuna', 'Moscow', 'Mountain Home', 'Blackfoot', 'Ammon', 'Chubbuck', 'Hailey',
  'Sandpoint', 'Burley', 'Jerome', 'Rupert', 'Emmett', 'Payette', 'Weiser', 'Fruitland', 'Star', 'Middleton', 'Parma',
  'Homedale', 'Marsing', 'Salmon', 'Challis', 'Driggs', 'Ketchum', 'Sun Valley', 'McCall', 'Cascade', 'Grangeville',
  'Orofino', 'Bonners Ferry', 'Priest River', 'Wallace', 'Kellogg', 'Preston', 'Soda Springs', 'Montpelier',
  'American Falls', 'Shoshone', 'Gooding', 'Buhl', 'Kimberly', 'Filer', 'Glenns Ferry', 'Horseshoe Bend', 'Idaho City',
  'Garden City', 'Hayden', 'Rathdrum', 'Spirit Lake', 'Athol', 'Shelley', 'Malad City', 'Lava Hot Springs', 'Stanley',
  'Mackay', 'Arco', 'Kamiah', 'Kooskia', 'Genesee', 'Troy', 'Potlatch', 'Plummer', 'Cataldo', 'Mullan', 'Ponderay',
  'Bonner County', 'Boundary County', 'Canyon County', 'Ada County', 'Kootenai', 'Nez Perce', 'Latah', 'Bingham',
  'Sawtooth', 'Redfish Lake', 'Bear Lake', 'Craters of the Moon', 'Snake River', 'Owyhee', 'Bogus Basin', 'Table Rock',
  'Seattle', 'Portland', 'Spokane', 'Salt Lake City', 'Denver', 'Phoenix', 'Las Vegas', 'Reno', 'Sacramento', 'San Diego',
  'Los Angeles', 'San Francisco', 'Chicago', 'New York', 'Boston', 'Austin', 'Dallas', 'Houston', 'Miami', 'Atlanta',
  'Nashville', 'Memphis', 'New Orleans', 'Kansas City', 'St Louis', 'Minneapolis', 'Detroit', 'Cleveland', 'Pittsburgh',
  'Philadelphia', 'Baltimore', 'Charlotte', 'Tampa', 'Orlando', 'Anchorage', 'Honolulu', 'Albuquerque', 'Tucson',
  'Omaha', 'Tulsa', 'Missoula', 'Bozeman', 'Billings', 'Butte', 'Helena', 'Jackson Hole', 'Cheyenne', 'Laramie', 'Provo',
  'Ogden', 'Logan', 'Bend', 'Eugene', 'Walla Walla', 'Yakima', 'Tacoma', 'Olympia', 'Great Falls', 'Casper', 'Rapid City',
  'Sioux Falls', 'Fargo', 'Des Moines', 'Madison', 'Milwaukee', 'Indianapolis', 'Columbus', 'Cincinnati', 'Louisville',
  'Richmond', 'Raleigh', 'Charleston', 'Savannah', 'Jacksonville', 'Birmingham', 'Little Rock', 'Wichita', 'Lincoln',
  'El Paso', 'San Antonio', 'Fort Worth', 'Scottsdale', 'Flagstaff', 'Sedona', 'Moab', 'Durango', 'Boulder',
  'Fort Collins', 'Santa Fe', 'Hancock', 'Dickinson', 'Essex', 'Sussex', 'Middlesex', 'Montana', 'Wyoming', 'Oregon',
  'Utah', 'Nevada', 'Washington', 'Idaho',
  // Idaho landmarks and a few more places found in review (the ones that contain a listed word are written ROT13)
  'Lake Lowell', 'Oreana', 'Texarkana', ...['Uryyf Pnalba', 'Uryyf Tngr', "Uryy'f Unys Nper", 'Pbba Encvqf'].map(rot13),
];

/** Sports teams (pro and college, Idaho and beyond). */
export const SPORTS_TEAMS = [
  'Broncos', 'Vandals', 'Bengals', 'Steelheads', 'Boise Hawks', 'Chukars', 'Seahawks', 'Mariners', 'Kraken', 'Sounders',
  'Storm', 'Trail Blazers', 'Timbers', 'Jazz', 'Real Salt Lake', 'Nuggets', 'Avalanche', 'Rockies', 'Raiders',
  'Golden Knights', 'Lakers', 'Clippers', 'Dodgers', 'Rams', 'Chargers', 'Ducks', '49ers', 'Warriors', 'Kings', 'Suns',
  'Cardinals', 'Diamondbacks', 'Cowboys', 'Mavericks', 'Texans', 'Rockets', 'Chiefs', 'Royals', 'Bears', 'Bulls', 'Cubs',
  'White Sox', 'Packers', 'Vikings', 'Lions', 'Patriots', 'Celtics', 'Red Sox', 'Bruins', 'Yankees', 'Mets', 'Knicks',
  'Nets', 'Eagles', '76ers', 'Steelers', 'Ravens', 'Browns', 'Titans', 'Jaguars', 'Dolphins', 'Heat', 'Buccaneers',
  'Lightning', 'Falcons', 'Hawks', 'Saints', 'Panthers', 'Bills', 'Colts', 'Bucks', 'Raptors', 'Canucks', 'Oilers',
  'Flames', 'Thunder', 'Spurs', 'Grizzlies', 'Magic', 'Hornets', 'Commanders', 'Wizards', 'Bulldogs', 'Huskies',
  'Cougars', 'Bobcats', 'Utes', 'Aggies', 'Wolf Pack', 'Rebels', 'Wildcats', 'Longhorns', 'Crimson Tide', 'Tigers',
  'Wolverines', 'Buckeyes', 'Fighting Irish', 'Gamecocks', 'Hokies', 'Demon Deacons', 'Blue Devils', 'Jayhawks',
  'Sooners', 'Cornhuskers', 'Hawkeyes', 'Badgers', 'Boilermakers', 'Gators', 'Hurricanes', 'Trojans', 'Spartans',
  'Hoosiers', 'Sun Devils', 'Tar Heels', 'Seminoles', 'Volunteers', 'Razorbacks', 'Mountaineers', 'Horned Frogs',
];

/** PG trash talk and game-chat banter. */
export const TRASH_TALK = [
  'get rekt', 'git gud', 'ez clap', 'too easy', 'skill issue', 'nice try', 'better luck next time', 'is that all you got',
  'you missed', 'whiff', 'bot behavior', 'noob', 'n00b', 'scrub', 'you got clapped', 'free kill', 'stay mad', 'cope',
  'ratio', 'gg ez', 'gg go next', 'you are toast', 'you are going down', 'prepare to lose', 'I am coming for you',
  'I will destroy you', 'I will crush you', 'gonna wreck you', 'I will smash your ship', 'rip bozo', 'bozo', 'clown',
  'sit down', 'get good', 'uninstall', 'go back to the tutorial', 'my grandma plays better', 'touch grass', 'lol no',
  'not even close', 'outplayed', 'sweaty', 'tryhard', 'camper', 'stop camping', 'spawn camper', 'you are so bad',
  'trash', 'garbage aim', 'potato aim', 'stormtrooper aim', 'cry about it', 'salty', 'so salty', 'tilted', 'rage quit',
  'free elo', 'you got carried', 'owned', 'pwned', 'boom headshot', 'sniped', 'nerd', 'dork', 'loser', 'weak', 'yikes',
  'oof', 'big oof', 'ouch', 'lmao', 'lol', 'rofl', 'omg', 'heck', 'dang it', 'frick', 'shoot', 'darn', 'what the heck',
  'you absolute walnut', 'go cry to mom', 'you fly like a brick', 'my turret has better aim', 'eat my rockets',
  'kill you in the arena', 'you are dead meat', 'hunting you down', 'nowhere to hide', 'I see you', 'target locked',
  'goodbye', 'see ya', 'later nerd', 'thanks for the points', 'donate more kills', 'you fed me', 'feeding', 'stop feeding',
];

/** Gamer slang and ordinary words that sit close to listed terms (the Scunthorpe traps of game chat). */
export const GAME_SLANG = [
  'glass cannon build', 'that was an assist', 'pass me the flag', 'classic mode', 'class change', 'cockpit view',
  'harass their backline', 'assassinate the healer', 'assign roles', 'assess the map', 'the grass map', 'bass boosted',
  'kite them', 'peel for me', 'focus the healer', 'nerf lasers', 'buff rockets', 'hitbox is huge', 'knockback combo',
  'crit chance', 'ult ready', 'aoe damage', 'dps check', 'stun lock', 'snare them', 'burst damage', 'sustain build',
  'cheese strat', "he'll be back", "she'll heal you", "we'll win", "I'll take mid", "don't push yet", "can't see",
  'shell shocked', 'hello there', 'the title screen', 'button mashing', 'butterfly route', 'scrap metal', 'scrapper build',
  'therapist mode lol', 'analysis paralysis', 'the analog stick', 'shiitake mushroom', 'cocktail party', 'peacock skin',
  'Titan hull', 'raccoon hat', 'spicy play', 'suspicious move', 'hospice for my ship', 'retardant foam', 'leotard skin',
  'tardis joke', 'sextant trophy', 'a hole in the wall', 'the pen is mightier', 'shoot the turret', 'kill the boss',
  'bomb site B', 'blow up the Hive', 'destroy the sentry', 'wreck the wall', 'dead again', 'I died', 'respawning',
  'push push push', 'fall back', 'regroup at spawn', 'on my way', 'omw', 'brb', 'afk 2 min', 'back', 'ty', 'np', 'wp',
  'gl hf', 'ggwp', 'rematch?', 'one more', 'last game', 'my mom says dinner', 'homework time', 'bell rings in 5',
  'sub to my channel', 'fps drops', 'ping is 200', 'lag spike', 'rubber banding', 'desync', 'server hiccup',
  'Farseer build', 'Riddick vibes',
  // clean, but each contains a listed word: written ROT13
  ...['pnhtug n penccvr ng Ynxr Ybjryy', 'penccvrf ner ovgvat', 'gvg sbe gng', 'zl pbba ubhaq vf ybhq', 'jr uvxrq Uryyf Pnalba',
    "Uryy'f Unys Nper arne Vqnub Snyyf"].map(rot13),
];

// ---------------------------------------------------------------------------------------------------------------
// Generation (deterministic)
// ---------------------------------------------------------------------------------------------------------------

/** The i-th item of a list, cycling. */
const at = <T>(list: readonly T[], i: number): T => list[((i % list.length) + list.length) % list.length];
const lower = (s: string): string => s.toLowerCase();

const LEVELS = [1, 2, 3, 5, 6, 8, 9, 10, 12, 15];
const WAVES = [1, 2, 3, 4, 5, 7, 10, 12, 15, 20, 25, 30];
const FLOORS = [1, 2, 3, 4, 5, 6];
const SECONDS = [5, 10, 15, 20, 30, 45, 60, 90];
const PERCENT = [10, 20, 25, 30, 40, 50, 60, 75, 80, 90, 100];
const BIG = ['900', '1.2k', '2k', '3.5k', '5k', '10k', '12k', '25k', '40k', '1.1m'];
const SCORES = [[3, 1], [10, 7], [2, 2], [15, 9], [5, 0], [21, 19], [100, 90], [300, 250], [7, 3], [1, 0]];
const CALL_NUMBERS = [7, 9, 11, 12, 17, 21, 23, 24, 27, 33, 42, 55, 64, 77, 99, 101, 360, 2010, 2012, 2013, 2015, 2016, 2025, 2026, 3000, 9000];
const LETTERS = ['A', 'B', 'C', 'D'];

/** Chat templates: each gets the running index `i` and picks its vocabulary from it. */
const TEMPLATES: readonly ((i: number) => string)[] = [
  (i) => `anyone want to run ${at(ROOM_NAMES, i)}?`,
  (i) => `${at(CLASS_NAMES, i)} is so good in ${at(SUB_MODE_NAMES, i + 1)}`,
  (i) => `who is playing ${at(CLASS_NAMES, i)}?`,
  (i) => `i'll go ${at(PATH_NAMES, i)} ${at(CLASS_NAMES, i)} this time`,
  (i) => `${at(SKILLS, i)} is on cooldown`,
  (i) => `use ${at(SKILLS, i)} on ${at(OBJECTIVES, i)}`,
  (i) => `${at(TALENT_NAMES, i)} is op`,
  (i) => `take ${at(TALENT_NAMES, i)} at level ${at(LEVELS, i)}`,
  (i) => `floor ${at(FLOORS, i)} boss incoming`,
  (i) => `wave ${at(WAVES, i)} spawning in ${at(SECONDS, i)}s`,
  (i) => `${at(TEAM_NAMES, i)} team push ${at(OBJECTIVES, i)}`,
  (i) => `cap the flag ${at(TEAM_NAMES, i)}!`,
  (i) => `hold point ${at(LETTERS, i)}`,
  (i) => `need a ${at(TURRETS, i)} on me`,
  (i) => `dock your ${at(TURRETS, i)} on my ${at(CAPITALS, i)}`,
  (i) => `my ${at(CAPITALS, i)} has ${1 + (i % 3)} turrets now`,
  (i) => `${at(CAPITAL_SKILLS, i)} ready`,
  (i) => `gg ${at(FIRST_NAMES, i)}`,
  (i) => `nice shot ${at(FIRST_NAMES, i)}!`,
  (i) => `${at(FIRST_NAMES, i)} from ${at(PLACES, i)} here`,
  (i) => `anyone from ${at(PLACES, i)}?`,
  (i) => `go ${at(SPORTS_TEAMS, i)}!`,
  (i) => `the ${at(SPORTS_TEAMS, i)} lost again lol`,
  (i) => at(TRASH_TALK, i),
  (i) => `${at(TRASH_TALK, i)} ${at(FIRST_NAMES, i + 7)}`,
  (i) => `lvl ${at(LEVELS, i)} ${at(CLASS_NAMES, i)}, ${at(PATH_NAMES, i + 2)} build`,
  (i) => `extract or descend? we are on floor ${at(FLOORS, i)}`,
  (i) => `descend! ${i % 2 ? 3 : 6} floors`,
  (i) => `${at(SET_NAMES, i)} dropped`,
  (i) => `${at(RARITY_NAMES, i)} from the ${at(SET_NAMES, i)}!`,
  (i) => `Quick Play ${at(GAME_TYPE_NAMES, i)}`,
  (i) => `join ${at(ROOM_NAMES, i)}`,
  (i) => `${at(SUB_MODE_NAMES, i)} or ${at(SUB_MODE_NAMES, i + 3)}?`,
  (i) => `we need ${2 + (i % 5)} more for ${at(SUB_MODE_NAMES, i)}`,
  (i) => `${i % 20}:${at(['05', '10', '15', '30', '45'], i)} left`,
  (i) => `${at(PERCENT, i)}% energy`,
  (i) => `${at(BIG, i)} damage with ${at(SKILLS, i)}`,
  (i) => `${at(SCORES, i)[0]}-${at(SCORES, i)[1]} ${at(TEAM_NAMES, i)} is winning`,
  (i) => `${lower(at(CLASS_NAMES, i))} ${lower(at(ARCHETYPES, i + 1))} or ${lower(at(PATH_NAMES, i + 4))}?`,
  (i) => `lol ${at(FIRST_NAMES, i)} got ${at(['sniped', 'rammed', 'blinked on', 'walled', 'zapped', 'rocketed'], i)}`,
  (i) => `${at(CLASS_NAMES, i)} + ${at(TURRETS, i + 1)} is broken`,
  (i) => `${at(FIRST_NAMES, i)} carry us pls`,
  (i) => `${at(TEAM_NAMES, i).toUpperCase()} WINS`,
  (i) => `the ${at(OBJECTIVES, i)} is contested`,
  (i) => `I have ${at(PERCENT, i)}% hull, heal me ${at(FIRST_NAMES, i + 3)}`,
  (i) => `${at(PLACES, i)} ${at(SPORTS_TEAMS, i)} fan here`,
  (i) => `period ${1 + (i % 7)} vs period ${1 + ((i + 3) % 7)} rematch`,
  (i) => `room 1${i % 4}${(i + 6) % 10} gets the ${at(GAME_TYPE_NAMES, i)} crown`,
  (i) => `${at(GAME_TEXT, i)}`,
  (i) => `brb, ${at(FIRST_NAMES, i)} take my ${at(TURRETS, i)}`,
  (i) => `${at(FIRST_NAMES, i)} and ${at(FIRST_NAMES, i + 11)} on ${at(OBJECTIVES, i)}`,
  (i) => `${at(TEAM_NAMES, i)} has ${at(OBJECTIVES, i + 2)}, ${at(TEAM_NAMES, i + 1)} go ${at(OBJECTIVES, i + 5)}`,
  (i) => `${at(SKILLS, i)} into ${at(SKILLS, i + 4)} combo`,
  (i) => `respec to ${at(PATH_NAMES, i)} for ${at(GAME_TYPE_NAMES, i)}`,
  (i) => `anyone else from ${at(PLACES, i)} or ${at(PLACES, i + 9)}?`,
  (i) => `${at(SPORTS_TEAMS, i)} vs ${at(SPORTS_TEAMS, i + 5)} tonight`,
  (i) => `${at(TRASH_TALK, i)}, ${at(CLASS_NAMES, i)} main`,
  (i) => `my ${at(CLASS_NAMES, i)} just hit level ${at(LEVELS, i)}`,
  (i) => `got the ${at(RARITY_NAMES, i)} hull from a ${at(SET_NAMES, i)}`,
  (i) => `${at(CAPITALS, i)} with ${1 + (i % 3)} ${at(TURRETS, i)}s is scary`,
  (i) => `wave ${at(WAVES, i)} was rough, ${at(PERCENT, i)}% hull left`,
  (i) => `${at(FIRST_NAMES, i)}: ${at(TRASH_TALK, i + 3)}`,
  (i) => `${at(ROOM_NAMES, i)} is full, try ${at(ROOM_NAMES, i + 1)}`,
  (i) => `@${at(FIRST_NAMES, i)} ${at(['nice', 'gg', 'wp', 'thanks', 'sorry', 'lol', 'omw', 'on it'], i)}`,
  (i) => at(GAME_SLANG, i),
  (i) => `${at(GAME_SLANG, i)} ${at(FIRST_NAMES, i + 5)}`,
];

/** At least 1500 distinct PG chat lines. */
export function fpChatLines(): string[] {
  const out = new Set<string>();
  // every template in turn, up to PER_TEMPLATE distinct lines each (a small vocabulary saturates early)
  const PER_TEMPLATE = 60;
  for (const t of TEMPLATES) {
    const mine = new Set<string>();
    for (let i = 0; mine.size < PER_TEMPLATE && i < PER_TEMPLATE * 4; i++) mine.add(t(i * 7 + (i >> 2)).slice(0, 200));
    for (const l of mine) out.add(l);
  }
  for (const s of GAME_TEXT) out.add(s.slice(0, 200));
  return [...out];
}

const ADJ = ['Neon', 'Void', 'Solar', 'Plasma', 'Laser', 'Rocket', 'Iron', 'Quantum', 'Hyper', 'Turbo', 'Nova', 'Astro',
  'Cosmic', 'Stellar', 'Lunar', 'Rift', 'Swarm', 'Hive', 'Pixel', 'Retro', 'Silent', 'Swift', 'Shadow', 'Frost',
  'Thunder', 'Storm', 'Blaze', 'Golden', 'Silver', 'Crystal', 'Arc', 'Flak', 'Seeker', 'Warp', 'Ion', ...TEAM_NAMES];
const NOUN = ['Moth', 'Otter', 'Falcon', 'Hawk', 'Wolf', 'Fox', 'Viper', 'Cobra', 'Raven', 'Comet', 'Pilot', 'Ace', 'Knight',
  'Ranger', 'Rider', 'Runner', 'Hunter', 'Striker', 'Blade', 'Lance', 'Spire', 'Forge', 'Anvil', 'Titan', 'Golem',
  'Wraith', 'Phantom', 'Drone', 'Sentry', 'Turret', 'Beacon', 'Nebula', 'Quasar', 'Pulsar', 'Photon', 'Rook', 'Bishop'];

/** The numbers players put on a callsign: 0-99, 007, round numbers, years, ordinals, "_7". */
export const CALLSIGN_NUMBERS: readonly string[] = [
  ...Array.from({ length: 100 }, (_, i) => String(i)), '007', '100', '123', '360', '420', '777', '1000', '2008', '2009', '2010', '2011',
  '2012', '2013', '2014', '1st', '2nd', '3rd', '4th', '5th', '7th', '10th', '_1', '_7', '_11', '_99', '_007',
];
/** Words other than first names that players number: places, teams, loot caches, game verbs and nouns. */
const NUMBERED_WORDS = [
  ...PLACES.filter((p) => !/\s|'/.test(p)), ...SPORTS_TEAMS.filter((t) => !/\s/.test(t) && !/\d/.test(t)),
  ...SET_NAMES.map((n) => n.replace(/\s+/g, '')), ...CLASS_NAMES, ...PATH_NAMES.map((n) => n.replace(/\s+/g, '')),
  'Clapped', 'Sniped', 'Dropped', 'Zapped', 'Rammed', 'Walled', 'Blinked', 'Picasso', 'StarWars', 'Cars', 'Apache', 'Farseer',
];

/**
 * Name + number callsigns — every first name and numbered word with every CALLSIGN_NUMBERS suffix (≤ 16 characters),
 * plus a leading number on each ("7Mia", "21Owen"). The most common callsign shape: a number must never read as a
 * leet letter that completes a listed term inside the name.
 */
export function fpNumberedCallsigns(): string[] {
  const out = new Set<string>();
  const add = (s: string): void => { if (s.length <= 16) out.add(s); };
  const bases = [...new Set([...FIRST_NAMES, ...NUMBERED_WORDS])];
  for (const b of bases) {
    for (const n of CALLSIGN_NUMBERS) add(`${b}${n}`);
    for (const n of ['1', '2', '4', '5', '9', '10', '21', '23', '99']) add(`${n}${b}`);
  }
  return [...out];
}

/** At least 500 distinct callsigns / room names (≤ 16 characters, the game's NAME_MAX_LEN). */
export function fpCallsigns(): string[] {
  const out = new Set<string>();
  const add = (s: string): void => { if (s.length <= 16 && s.length >= 2) out.add(s); };
  for (let i = 0; i < ADJ.length * 3; i++) add(`${at(ADJ, i)}${at(NOUN, i * 5 + 1)}`);
  for (let i = 0; i < ADJ.length; i++) add(`${at(ADJ, i)}_${at(NOUN, i + 3)}`);
  for (let i = 0; i < NOUN.length; i++) add(`xX_${at(NOUN, i)}_Xx`);
  for (let i = 0; i < FIRST_NAMES.length; i++) {
    add(at(FIRST_NAMES, i));
    if (i % 2) add(`${at(FIRST_NAMES, i)}${at(CALL_NUMBERS, i)}`);
    if (i % 3 === 0) add(`${at(FIRST_NAMES, i)}_${at(NOUN, i)}`);
  }
  for (const c of [...CLASS_NAMES, ...PATH_NAMES, ...CAPITALS]) {
    add(c);
    for (let k = 0; k < 3; k++) add(`${c}${at(CALL_NUMBERS, c.length + k * 5)}`);
    add(`${at(TEAM_NAMES, c.length)}${c}`);
  }
  for (const s of [...SKILLS, ...TALENT_NAMES, ...TURRETS, ...CAPITAL_SKILLS]) add(s.replace(/\s+/g, '_'));
  for (let i = 0; i < PLACES.length; i++) {
    const p = at(PLACES, i).replace(/\s+/g, '');
    add(p);
    add(`${p}${at(NOUN, i)}`);
  }
  for (const t of SPORTS_TEAMS) { const n = t.replace(/\s+/g, ''); add(`${n}Fan`); add(`${n}_4ever`); }
  for (const r of ROOM_NAMES) add(r);
  for (let i = 0; i < 40; i++) add(`Period ${1 + (i % 7)} ${at(GAME_TYPE_NAMES, i)}`);
  for (let i = 0; i < 20; i++) add(`Room 136 ${at(SUB_MODE_NAMES, i)}`);
  return [...out];
}

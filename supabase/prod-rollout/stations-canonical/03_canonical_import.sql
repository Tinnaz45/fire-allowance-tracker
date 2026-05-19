-- ════════════════════════════════════════════════════════════════════════════
-- PROD ROLLOUT — fat.stations canonical FRV cutover
-- Step 03: CANONICAL DATASET IMPORT
--
-- Source of truth: FRV Allowances - Current.xlsx → "Stations" tab.
-- 82 active stations across 96 numbered slots (14 reserved/missing gaps).
-- Gaps (preserved from FRV): 17, 21, 36, 37, 49, 65, 69, 74, 75, 76, 77, 78, 79, 83.
--
-- Run order:
--   1. 00_preflight_inspect.sql  (read-only)
--   2. 01_snapshot_existing.sql  (backup)
--   3. 02_schema_extension.sql   (adds columns)
--   4. 03_canonical_import.sql   (THIS FILE — wipes & re-seeds rows)
--   5. 04_validate.sql           (post-checks)
--
-- ⚠️  Pre-flight requirement: the inventory query in 00_preflight_inspect.sql
--     (item 4) MUST return zero rows whose `sid` is NOT in the canonical id
--     set below. If any user references stale DEV-derived ids that disappear
--     in this import, profile_ext.station_id will be nulled via the existing
--     ON DELETE SET NULL rule, but historical claim rows in recalls/retain/
--     standby/spoilt_meals are NOT FK-protected and would be left pointing at
--     missing ids. If PROD has such rows, prepare a remap UPDATE before this
--     step rather than proceeding blindly.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DELETE FROM fat.stations;

INSERT INTO fat.stations
  (id, name, abbreviation, district, street_address, suburb, postcode)
VALUES
  (1, 'Eastern Hill', 'FS01', 'Central', '456 Albert St', 'East Melbourne', '3002'),
  (2, 'West Melbourne', 'FS02', 'Central', '60 Batman St', 'West Melbourne', '3003'),
  (3, 'Carlton', 'FS03', 'Central', '106 Bouverie St', 'Carlton', '3053'),
  (4, 'Brunswick', 'FS04', 'Central', '24 Blyth St', 'Brunswick', '3056'),
  (5, 'Broadmeadows', 'FS05', 'Northern', '338 Camp Rd', 'Broadmeadows', '3047'),
  (6, 'Pascoe Vale', 'FS06', 'Northern', '345A Gaffney St', 'Pascoe Vale', '3044'),
  (7, 'Thomastown', 'FS07', 'Northern', '92 Mahoneys Rd', 'Thomastown', '3074'),
  (8, 'Burnley Complex', 'FS08', 'Central', '450 Burnley St', 'Richmond', '3121'),
  (9, 'Somerton', 'FS09', 'Northern', '10 Somerton Park Dr', 'Campbellfield', '3061'),
  (10, 'Richmond', 'FS10', 'Central', '55 Church St', 'Richmond', '3121'),
  (11, 'Epping', 'FS11', 'Northern', '28 Childs Rd', 'Epping', '3076'),
  (12, 'Preston', 'FS12', 'Northern', '471 Bell St', 'Preston', '3072'),
  (13, 'Northcote', 'FS13', 'Central', '3 Mitchell St', 'Northcote', '3070'),
  (14, 'Bundoora', 'FS14', 'Northern', '1083 Plenty Rd', 'Bundoora', '3083'),
  (15, 'Heidelberg', 'FS15', 'Northern', '161 Bell St', 'Heidelberg', '3084'),
  (16, 'Greensborough', 'FS16', 'Northern', '141 Grimshaw St', 'Greensborough', '3064'),
  (18, 'Hawthorn', 'FS18', 'Central', '45 William St', 'Hawthorn', '3122'),
  (19, 'North Balwyn', 'FS19', 'Eastern', '312 Doncaster Rd', 'North Balwyn', '3104'),
  (20, 'Box Hill', 'FS20', 'Eastern', '1052 Maroondah Hwy', 'Box Hill', '3128'),
  (22, 'Ringwood', 'FS22', 'Eastern', '272 Maroondah Hwy', 'Ringwood', '3134'),
  (23, 'Burwood', 'FS23', 'Eastern', '25 Highbury Rd', 'Burwood', '3125'),
  (24, 'Glen Iris (Malvern)', 'FS24', 'Southern 1', '1721 Malvern Rd', 'Glen Iris', '3146'),
  (25, 'Oakleigh', 'FS25', 'Southern 1', '100 Atherton Rd', 'Oakleigh', '3166'),
  (26, 'Croydon', 'FS26', 'Eastern', '306 Dorset Rd', 'Croydon', '3136'),
  (27, 'Nunawading', 'FS27', 'Eastern', '364 Maroondah Hwy', 'Nunawading', '3131'),
  (28, 'Vermont South', 'FS28', 'Eastern', '721 Highbury Rd', 'Vermont South', '3133'),
  (29, 'Clayton', 'FS29', 'Southern 1', '529 Clayton Rd', 'Clayton', '3169'),
  (30, 'Templestowe', 'FS30', 'Eastern', '40 Serpells Rd', 'Templestowe', '3106'),
  (31, 'Glen Waverley', 'FS31', 'Southern 1', '645 Ferntree Gully Rd', 'Glen Waverley', '3150'),
  (32, 'Ormond', 'FS32', 'Southern 1', '311 North Rd', 'Caulfield South', '3162'),
  (33, 'Mentone', 'FS33', 'Southern 1', '103 Nepean Hwy', 'Mentone', '3194'),
  (34, 'Highett', 'FS34', 'Southern 1', '150 Wickham Rd', 'Highett', '3190'),
  (35, 'Windsor', 'FS35', 'Central', '156 Albert St', 'Windsor', '3181'),
  (38, 'South Melbourne', 'FS38', 'Central', '26 Moray St', 'South Melbourne', '3205'),
  (39, 'Port Melbourne', 'FS39', 'Central', '448 Graham St', 'Port Melbourne', '3207'),
  (40, 'Laverton', 'FS40', 'Western 1', '5 Epsom St', 'Laverton', '3028'),
  (41, 'St Albans', 'FS41', 'Western 2', '9 Taylors Rd', 'St Albans', '3021'),
  (42, 'Newport', 'FS42', 'Western 1', '231 Melbourne Rd', 'Newport', '3015'),
  (43, 'Deer Park', 'FS43', 'Western 2', '780A Ballarat Rd', 'Deer Park', '3023'),
  (44, 'Sunshine', 'FS44', 'Western 2', '30 McIntyre Rd', 'Sunshine', '3020'),
  (45, 'Brooklyn', 'FS45', 'Western 1', '29 Millers Rd', 'Brooklyn', '3012'),
  (46, 'Altona', 'FS46', 'Western 1', '7 Akuna St', 'Altona', '3018'),
  (47, 'Footscray', 'FS47', 'Western 1', '69 Droop St', 'Footscray', '3011'),
  (48, 'Taylor''s Lakes', 'FS48', 'Western 2', '470 Melton Hwy', 'Taylors Lakes', '3038'),
  (50, 'Ascot Vale', 'FS50', 'Central', '258 Union Rd', 'Moonee Ponds', '3039'),
  (51, 'Keilor', 'FS51', 'Western 2', '144 Milleara Rd', 'East Keilor', '3033'),
  (52, 'Tullamarine', 'FS52', 'Western 2', '1 Western Ave', 'Tullamarine', '3043'),
  (53, 'Sunbury', 'FS53', 'Western 2', '144 Gap Rd', 'Sunbury', '3429'),
  (54, 'Greenvale', 'FS54', 'Western 2', '33 Barrymore Rd', 'Greenvale', '3059'),
  (55, 'Caroline Springs', 'FS55', 'Western 2', '8-10 Caroline Springs Bvd', 'Caroline Springs', '3012'),
  (56, 'Melton', 'FS56', 'Western 2', '40-44 Henry St', 'Melton', '3337'),
  (57, 'Tarneit', 'FS57', 'Western 1', '417 Derrimut Rd', 'Tarneit', '3029'),
  (58, 'Point Cook', 'FS58', 'Western 1', '85-93 Dunnings Rd', 'Point Cook', '3030'),
  (59, 'Derrimut', 'FS59', 'Western 1', '337 Fitzgerald Road', 'Derrimut', '3026'),
  (60, 'VEMTC', 'FS60', 'Northern', '284-290 Hume Highway', 'Craigieburn', '3064'),
  (61, 'Lara', 'FS61', 'Western 3', '25 Mill Rd', 'Lara', '3212'),
  (62, 'Corio', 'FS62', 'Western 3', '20-32 Birdwood Ave', 'Norlane', '3214'),
  (63, 'Geelong City', 'FS63', 'Western 3', '69 McKillop St', 'Geelong', '3220'),
  (64, 'Belmont', 'FS64', 'Western 3', '2-4 Reynolds Rd', 'Belmont', '3216'),
  (66, 'Ocean Grove', 'FS66', 'Western 3', '5-11 Shell Rd', 'Ocean Grove', '3226'),
  (67, 'Ballarat City', 'FS67', 'North & West Regional', '1120 Sturt St', 'Ballarat', '3350'),
  (68, 'Lucas', 'FS68', 'North & West Regional', '89 Ballarat-Carngham Rd', 'Winter Valley', '3358'),
  (70, 'Warrnambool', 'FS70', 'North & West Regional', '61-67 Mortlake Rd', 'Warrnambool', '3280'),
  (71, 'Portland', 'FS71', 'North & West Regional', '130 Percy St', 'Portland', '3305'),
  (72, 'Mildura', 'FS72', 'North & West Regional', '338 San Mateo Ave', 'Mildura', '3500'),
  (73, 'Bendigo', 'FS73', 'North & West Regional', '145-149 Hargreaves St', 'Bendigo', '3550'),
  (80, 'Craigieburn', 'FS80', 'Northern', '2 Belsay Pl', 'Craigieburn', '3064'),
  (81, 'South Morang', 'FS81', 'Northern', '875 Plenty Rd', 'South Morang', '3752'),
  (82, 'Eltham City', 'FS82', 'Eastern', '61 Brougham St', 'Eltham', '3095'),
  (84, 'South Warrandyte', 'FS84', 'Eastern', '29 Falconer Rd', 'Park Orchards', '3114'),
  (85, 'Boronia', 'FS85', 'Eastern', '296-306 Boronia Rd', 'Boronia', '3155'),
  (86, 'Rowville', 'FS86', 'Southern 1', '1063 Wellington Rd', 'Rowville', '3178'),
  (87, 'Dandenong', 'FS87', 'Southern 2', '186-190 Princes Hwy', 'Dandenong', '3175'),
  (88, 'Hallam', 'FS88', 'Southern 2', '12 Belgrave-Hallam Rd', 'Hallam', '3803'),
  (89, 'Springvale', 'FS89', 'Southern 1', '518 Springvale Rd', 'Springvale South', '3172'),
  (90, 'Patterson River', 'FS90', 'Southern 2', '37 McLeod Rd', 'Carrum', '3197'),
  (91, 'Frankston', 'FS91', 'Southern 2', '3 Cranbourne Rd', 'Frankston', '3199'),
  (92, 'Cranbourne', 'FS92', 'Southern 2', '8-10 Arundel St', 'Cranbourne', '3977'),
  (93, 'Pakenham', 'FS93', 'Southern 2', '780 Princes Hwy', 'Pakenham', '3810'),
  (94, 'Mornington', 'FS94', 'Southern 2', '859 Nepean Hwy', 'Mornington', '3931'),
  (95, 'Rosebud', 'FS95', 'Southern 2', '99-101 Boneo Rd', 'Rosebud', '3939'),
  (96, 'Derrimut RCRS', 'FS96', 'Western 1', '95 Fulton Drive', 'Derrimut', '3026');

COMMIT;

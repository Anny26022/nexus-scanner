# Taxonomy audit — 2026-10-14

## Scope

This audit compares the active 2,604-stock universe with the available 4,800-row StockScans extract. The source reports 6,725 rows, but the remaining pages were unavailable after a source rate limit, so source coverage is partial.

## Remediation update — 2026-10-15

Final precedence update: the pinned StockScans extract now takes priority over
the earlier remediation below. Exact NSE matches cover 2,251 of 2,604 stocks;
353 retain reviewed corrections or provider classifications. A full offline replay
originally changed 2,215 primary pairs and yielded 109 sectors and 480 industries.
Applying the existing four spelling aliases consistently to extract rows further
normalizes 28 current-universe entries and reduces the sector count to 105;
industry coverage remains 480. Nexus
Journal theme records remain identical. AUGMONT therefore uses StockScans'
`Trading` primary sector while retaining its researched bullion/refining tags.
The counts and outcomes below document the earlier remediation stage, not this
final primary-source switch. JSON audit reports likewise retain their original
scope and matching rules and are historical evidence, not final coverage counts.

- Applied the 79 specific StockScans classifications as reviewed primary sector/industry overrides.
- Researched and classified 11 `Trading`/`Miscellaneous` records from company and exchange sources. The tailored classifications include building-material retail, mining consulting, metal recycling, education infrastructure, industrial/logistics parks, asset-pooling logistics, developmental care, luxury fashion retail, subscription rental, and industrial utilities.
- `GRADIENTE` was classified from the company’s media-and-entertainment disclosures despite its absence from the partial StockScans extract.
- Only `NEUEON` remains deliberately unclassified. Its current company presentation and recent exchange material describe incompatible operating businesses, so it is retained in the explicit `needs_review` queue rather than guessed.

The applied data lives in `DO NOT DELETE EDL PIPELINE/taxonomy_overrides.json`. It contains 91 overrides in total: Augmont plus 79 source-specific and 11 externally researched classifications. It is a packaged pipeline resource, not a browser override.

## Outcome

- Augmont was classified manually as **Bullion & Precious Metals** / **Bullion Platform, Refining & Precious Metals**, with the secondary niche **Jewellery & Watches**.
- The six earlier sector-only mappings are removed: four replaced broad sectors with narrower categories, while Chemicals and Banks were identity replacements. Existing provider sector/industry pairs are retained instead.
- This document’s original queues below are retained as an audit trail. After remediation, one symbol (`NEUEON`) remains unclassified in the 2,604-stock snapshot.

## Integration verification

An offline replay on the 14 October snapshot through the pipeline resolver yields
72 sectors and 268 industries, with only `NEUEON` incomplete and 16 stocks carrying
secondary niche tags. Original provider labels preserve all 2,604 existing theme
records exactly: 222 primary themes, 274 source sub-industries, 27 blocks and six
macro pillars. This preserves existing assignment confidence; it does not turn
industry-bridge assignments into individually researched niches. The browser no
longer rewrites classifications in existing immutable snapshots. These changes
take effect in a future full pipeline publication, not in already-published data.

The additional four tagged stocks reflect reviewed bullion/refining exposure,
not new primary sector assignments. AUGMONT's existing tags are expanded;
RAJESHEXPO, AUSOMENT, ABANSENT and MMTC receive tag-only assignments with source
URLs. MMTC is marked as JV exposure, and AUSOMENT distinguishes direct trading
from refinery JV exposure. LGHL is pending corroboration; its primary
classification is retained.

## Coverage and agreement

The agreement counts below record the earlier comparison before removal of the
six sector-only replacements; they are retained as historical audit results.

| Metric | Count |
| --- | ---: |
| Our universe | 2604 |
| Matched by symbol in extract | 2558 |
| Our symbols absent from extract | 46 |
| StockScans-only symbols in partial extract | 2239 |
| Exact sector labels after approved mappings | 802 |
| Exact industry labels | 142 |
| Exact sector and industry labels | 53 |

After the remediation, exact agreement against the same partial extract is 881 sectors, 221 industries, and 132 exact sector-and-industry pairs. These figures intentionally do not count tailored classifications that improve business fidelity but use a different taxonomy label.

## Highest-priority completeness queue

These records have no usable internal sector or industry but do have a specific StockScans classification. They are candidates for human classification, not automatic replacements.

| Symbol | Company | StockScans sector | StockScans industry |
| --- | --- | --- | --- |
| AASTHA | Aastha Spintex | Textiles | Textiles Others |
| ACEVECTOR | AceVector | E-Commerce/App based Aggregator | E-Services |
| ADROITIND | Adroit Industries | Auto Ancillaries | Auto Ancillaries - Others |
| AGL | Allcargo Global | Logistics | Miscellaneous |
| ALPINETEX | Alpine Texworld | Textiles | Textiles Others |
| ANNU | Annu Projects | Infrastructure Developers and Operators | Construction Civil and Turnkey |
| AONESTEELS | A One Steels | Steel | Steel - Medium / Small |
| ARCIL | Asset Reconstruction Company | Finance | Finance Investment and Others |
| ARDEE | Ardee Industries | Non Ferrous Metals | Metal Others |
| ARMEE | ArMee Infotech | IT - Software | Computers - Software - Medium / Small |
| BURNPUR | Burnpur Cement | Cement | Cement |
| CAPILLARY | Capillary Technologies | IT Software | IT Services |
| CMLL | Caliber Mining & Logistics | Mining and Mineral Products | Mining and Minerals |
| CORDELIA | Waterways Leisure Tourism | E Commerce and App based Aggregator | Travel Agencies |
| CSM | CSM Technologies | IT Software | IT Services |
| DCMSIL | DCM Shriram International | Textiles | Textiles Rayon |
| DEEPA | Deepa Jewellers | Diamond Gems and Jewellery | Diamond Gems and Jewellery |
| DHOOTTRANS | Dhoot Transmission | Capital Goods Electrical Equipment | Electric Equipment General |
| DSFCL | DCM Shriram Fine Chemicals | Chemicals | Chemicals Organic |
| DSKULKARNI | DS Kulkarni Developers | Realty | Construction Housing |
| EASTSILK | Eastern Silk Industries | Textiles | Textiles Silk |
| ESDS | ESDS Software Solution | IT Software | IT Services |
| GAJA | Gaja Alternative Asset Management | Finance | Finance Investment and Others |
| GERMAN | German Green Steel and Power  | Steel | Steel - Medium / Small |
| GLASSWALL | Glass Wall Systems | Construction | Construction Civil and Turnkey |
| GSPLTRANS | GSPL Transmission | Gas Distribution | Gas Distribution |
| HEROMOTORS | Hero Motors | Auto Ancillaries | Auto Ancillaries - Others |
| HEXAGON | Hexagon Nutrition | FMCG | Food Processing Others |
| HTEL | Hy-Tech Engineers | Capital Goods Non Electrical Equipment | Hydraulics |
| INDOMIM | Indo-MIM | Capital Goods Non Electrical Equipment | Engineering Light General |
| JNPR | Juniper Green Energy | Power Generation and Distribution | Power Generation and Distribution |
| JSIPL | Jindal Supreme | Steel | Steel - Tubes / Pipes |
| KANOHAR | Kanohar Electricals | Capital Goods Electrical Equipment | Capital Goods Transformers |
| KARAMTARA | Karamtara Engineering | Capital Goods Electrical Equipment | Transmission Line Towers and Equipment |
| KNACK | Knack Packaging | Packaging | Packaging FMCG and Consumers |
| KSR | KSR Footwear | Leather | Leather and Synthetic Footwear |
| KUSUMGAR | Kusumgar | Textiles | Textiles Manmade PFY and PSF |
| LALITHAA | Lalithaa Jewellery Mart | Diamond Gems and Jewellery | Diamond Gems and Jewellery |
| LASERPOWER | Laser Power & Infra | Cables | Cables Power |
| LCCPROJECT | LCC Projects | Infrastructure Developers and Operators | Construction Civil and Turnkey |
| LCL | Lohia Corp | Engineering | Textile Machinery |
| LUMINO | Lumino Industries | Infrastructure Developers and Operators | Engineering Turnkey Services |
| MANIKA | Manika Plastech | Plastic Products | Plastics Others |
| MANIPALHOS | Manipal Health Enterprises | Healthcare | Hospitals |
| MBECL | McNally Bharat Engineering Comp | Infrastructure Developers and Operators | Engineering Turnkey Services |
| MILKYMIST | Milky Mist Dairy Food | FMCG | FMCG Dairy Products |
| MOLBIO | Molbio Diagnostics | Healthcare | Medical Equipment |
| MONEYVIEW | Moneyview | E-Commerce/App based Aggregator | Computers - Software - Medium / Small |
| MPIMANIPAL | Manipal Payment and Identity Solutions | IT Software | IT Services |
| MVELECTRO | MV Electrosystems | Consumer Durables | Electronics Power Devices and Equipment |
| NITYAS | Nityas Gems & Jewellery | Diamond, Gems and Jewellery | Diamond Cutting / Jewellery - Medium / Small |
| ORIENTCABL | Orient Cables | Cables | Cables - Telephone |
| PRANAV | Pranav Constructions | Construction | Construction Housing |
| PRASOLCHEM | Prasol Chemicals | Chemicals | Specialty Chemicals |
| PRIORITY | Priority Jewels | Diamond Gems and Jewellery | Diamond Gems and Jewellery |
| RAMBHAJO | Advit Jewels | Diamond Gems and Jewellery | Diamond Gems and Jewellery |
| RUNWALENTR | Runwal Enterprises | Realty | Construction - Housing - Medium / Small |
| SBIFUNDS | SBI Funds Management | Finance | Finance AMC |
| SHAHINVEST | Shah Investors Home | Stock/ Commodity Brokers | Securities/Commodities Trading Services |
| SHANKESH | Shankesh Jewellers | Diamond Gems and Jewellery | Diamond Gems and Jewellery |
| SKFINDUS | SKF India Industrial | Bearings | Bearings |
| SKYWAYS | Skyways Air Services | Logistics | Miscellaneous |
| SONA | Sonaselection | Textiles | Textiles - Spinning - Synthetic / Blended |
| SRIT | SRIT | IT - Software | Computers - Software - Medium / Small |
| SSRETAIL | SS Retail | Retail | Trading - Medium / Small |
| SUNSHINE | Sunshine Pictures | Entertainment | Entertainment Electronic Media |
| SWASTIKAIN | Swastika Infra | Power Infrastructure | Engineering - Turnkey Services |
| SYMBIOTEC | Symbiotec Pharmalab | Pharmaceuticals | Pharma API |
| TECHNOCRAF | Technocraft Ventures | Infrastructure Developers and Operators | Construction Civil and Turnkey |
| TEMPSENS | Tempsens Instruments | Engineering | Engineering Light General |
| TENNIND | Tenneco Clean Air | Auto Ancillaries | Auto Others |
| TRIVENIPT | Triveni Power Transmission | Engineering | Engineering - Heavy - General - Medium / Small |
| TURTLEMINT | Turtlemint Fintech Solutions | Insurance | Insurance Distribution |
| UTLSOLAR | Fujiyama Power Systems | Capital Goods Electrical Equipment | Electric Equipment General |
| VARMORA | Varmora Granito | Ceramic Products | Ceramics - Tiles |
| VEEGALAND | Veegaland Developers | Realty | Realty Regional |
| VNL | Vishal Nirmiti | Infrastructure Developers & Operators | Construction - Civil / Turnkey - Large |
| WAAREEINDO | Indosolar | Capital Goods Electrical Equipment | Electric Equipment General |
| XTRANET | Xtranet Technologies | IT Software | IT Services |

## Deliberately manual queue

`Trading` and `Miscellaneous` do not identify a stable primary business. Keep these 11 records in manual review.

| Symbol | Company | StockScans sector | StockScans industry |
| --- | --- | --- | --- |
| BUILDPRO | Shankara Buildpro | Trading | Trading |
| CMPDI | Central Mine P & D Institute | Miscellaneous | Miscellaneous |
| CMRGREEN | CMR Green Technologies | Miscellaneous | Miscellaneous |
| ELEVATE | Elevate Campuses | Miscellaneous | Miscellaneous - Medium / Small |
| HORIZONIND | Horizon Industrial Parks | Miscellaneous | Miscellaneous |
| LEAPIND | LEAP | Miscellaneous | Miscellaneous |
| MOMSBELIEF | Rays of Belief | Miscellaneous | Miscellaneous |
| NEUEON | Neueon Corporation | Trading | Trading |
| PERNIASPOP | Purple Style Labs | Trading | Trading |
| RENTOMOJO | Rentomojo | Miscellaneous | Miscellaneous |
| STEAMHOUSE | Steamhouse | Miscellaneous | Miscellaneous |

## Structural taxonomy differences, not automatic errors

The most frequent sector mismatches reflect different hierarchy choices.

| StockScans sector | Our sector | Stocks | Examples |
| --- | --- | ---: | --- |
| Finance | Financial Services | 156 | 3PLAND, AADHARHFC, AAVAS, ABCAPITAL, ADVIKCA |
| Infrastructure Developers and Operators | Construction | 74 | A2ZINFRA, ABINFRA, AFCONS, AKASH, ASHOKA |
| Capital Goods Electrical Equipment | Capital Goods | 51 | AARTECH, ABB, AEPL, APARINDS, ATLANTAELE |
| Steel | Industrial Products | 51 | AEROENTER, AEROFLEX, BANSALWIRE, BEEKAY, BHARATWIRE |
| Consumer Durables | Consumer Goods | 44 | AMBER, AROGRANITE, ATLASCYCLE, BAJAJELEC, BLUESTARCO |
| FMCG | Food Products | 41 | ADFFOODS, ANNAPURNA, APEX, AVANTIFEED, BBTC |
| Capital Goods Non Electrical Equipment | Capital Goods | 34 | AARON, ANUP, ATAM, BAJAJINDEF, BAJAJST |
| Logistics | Logistics & Cargo | 33 | ACCURACY, ALLCARGO, ARSHIYA, AVG, BLACKBUCK |
| Healthcare | Healthcare Services | 31 | 3BBLACKBIO, AGARWALEYE, APOLLOHOSP, ARTEMISMED, ASTERDM |
| Capital Goods Non Electrical Equipment | Industrial Products | 30 | ADOR, APLAPOLLO, CARBORUNIV, CUMMINSIND, DENORA |
| Packaging | Industrial Products | 30 | AERONEU, AGI, AMDIND, BALAJEE, BBTCL |
| Cement | Construction | 28 | ACC, ACL, AMBUJACEM, APCL, BIRLACORPN |
| Diamond Gems and Jewellery | Consumer Goods | 27 | AGOL, ASTAR, AUSOMENT, BLUESTONE, DPABHUSHAN |
| Sugar | Consumer Goods | 27 | AVADHSUGAR, BAJAJHIND, BALRAMCHIN, BANARISUG, DALMIASUG |
| Power Generation and Distribution | Power | 26 | ACMESOLAR, ADANIENSOL, ADANIGREEN, ADANIPOWER, CESC |
| Stock and Commodity Brokers | Capital Markets | 25 | 360ONE, 5PAISA, ALMONDZ, ANGELONE, ARIHANTCAP |
| Entertainment | Media | 25 | AQYLON, BAGFILMS, BALAJITELE, BTML, CINELINE |
| Agro Chemicals | Chemicals | 24 | ADVANCE, ASTEC, BAYERCROP, BESTAGRO, BHAGCHEM |
| Aerospace and Defence | Aerospace & Defense | 24 | AEQUS, APOLLO, ASTRAMICRO, AVANTEL, BDL |
| Trading | Commercial Services | 22 | ABMINTLLTD, AKG, ANIKINDS, ASIANTNE, BNAGROCHEM |

## Source labels that are too broad for a global mapping

| StockScans sector | Matched stocks | Our sector targets | Most common targets |
| --- | ---: | ---: | --- |
| Miscellaneous | 60 | 24 | Commercial Services (16); Unclassified (8); Utilities (4); Construction (4) |
| Trading | 74 | 23 | Commercial Services (22); Metals & Mining (7); Consumer Goods (7); Construction (4) |
| Finance | 186 | 12 | Financial Services (156); Capital Markets (16); Unclassified (3); Commercial Services (2) |
| Textiles | 134 | 12 | Textiles (115); Unclassified (6); Industrial Products (3); Forest Materials (2) |
| Infrastructure Developers and Operators | 104 | 11 | Construction (74); Capital Goods (7); Unclassified (5); Utilities (5) |
| Steel | 87 | 10 | Industrial Products (51); Metals & Mining (21); Capital Goods (6); Unclassified (3) |
| Realty | 88 | 9 | Realty (71); Commercial Services (6); Unclassified (3); Media (2) |
| IT Software | 138 | 8 | IT Software (117); Commercial Services (10); Unclassified (5); Financial Services (2) |
| Chemicals | 129 | 8 | Chemicals (118); Petroleum Products (4); Unclassified (2); Consumer Goods (1) |
| FMCG | 89 | 8 | Food Products (41); FMCG (30); Consumer Goods (11); Unclassified (2) |
| Capital Goods Electrical Equipment | 65 | 8 | Capital Goods (51); Unclassified (5); Consumer Goods (3); Power (2) |
| E Commerce and App based Aggregator | 25 | 8 | Retail (9); Financial Services (7); Leisure Services (4); Unclassified (1) |
| Diversified | 21 | 8 | Diversified (6); Commercial Services (6); Textiles (2); Logistics & Cargo (2) |
| Power Generation and Distribution | 34 | 7 | Power (26); Metals & Mining (2); Utilities (2); Transport (1) |
| Mining and Mineral Products | 16 | 7 | Metals & Mining (9); Energy (2); Oil & Gas (1); Unclassified (1) |

## Recommendation

Use one primary sector and industry for screening, plus optional `nicheTags` for cross-cutting investment themes. Do not globally replace categories such as `Trading`, `Miscellaneous`, `FMCG`, or `Steel` from a source label alone. The machine-readable audit contains the complete queues and mapping evidence.

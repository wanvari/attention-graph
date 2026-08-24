#!/usr/bin/env node
// Generates fixtures/pages.json and fixtures/visits.json deterministically.
// The curation lives in the per-topic sentence banks below; composition is
// mechanical and seeded, so the dataset is reviewable and regenerable.
// Non-personal by construction. See spec §7.3.
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- seeded rng
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260301);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const shuffle = arr => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// ------------------------------------------------------------------- topics
const TOPICS = [
  {
    id: 'sourdough-baking',
    domains: ['theperfectloaf.com', 'kingarthurbaking.com', 'breadtopia.com', 'seriouseats.com'],
    titles: [
      'Managing sourdough starter hydration in winter', 'Why my sourdough crumb is dense and gummy',
      'Autolyse versus fermentolyse for high-hydration dough', 'Scoring patterns for batard loaves',
      'Cold retard timing for open crumb', 'Whole wheat starter conversion guide',
      'Dutch oven versus baking steel for oven spring', 'Bulk fermentation temperature charts',
      'Stiff starter and sweet levain differences', 'Troubleshooting flat sourdough loaves',
      'Rye flour in a wheat levain', 'Bench rest and pre-shape tension', 'Baker math for 78 percent hydration',
      'Sourdough discard crackers and pancakes', 'Steam in a home oven for crust'
    ],
    sentences: [
      'A sourdough starter fed at a one to five to five ratio doubles more slowly in a cold kitchen, so winter feeding schedules stretch to twelve hours.',
      'Bulk fermentation is done when the dough has risen about fifty percent and the edge where dough meets bowl is domed rather than flat.',
      'High hydration doughs above eighty percent water need coil folds instead of stretch and folds to build strength without tearing the gluten.',
      'The autolyse rest lets flour hydrate fully before salt tightens the gluten network, shortening mix time and improving extensibility.',
      'An overproofed loaf collapses when scored because the gluten has already stretched to its limit and the gas cells have merged.',
      'Cold retarding shaped loaves overnight in the refrigerator deepens flavor through slow acid production and makes scoring far easier.',
      'Oven spring depends on trapped steam keeping the crust soft during the first fifteen minutes so the loaf can expand before it sets.',
      'A stiff levain at fifty percent hydration favors acetic acid and a tangier loaf, while a liquid levain favors milder lactic notes.',
      'Dense gummy crumb usually means underfermentation, not underbaking, and the fix is a longer warmer bulk rather than more oven time.',
      'Whole grain flours ferment faster because the bran carries more wild yeast and enzymes, so cut bulk time when converting a white recipe.',
      'Baker percentages express every ingredient relative to total flour weight, which makes scaling a formula from one loaf to four trivial.',
      'Scoring at a shallow thirty degree angle with a curved lame produces the ear, the raised flap of crust that marks a well-fermented loaf.',
      'The windowpane test shows gluten development when a small piece of dough stretches thin enough to pass light without tearing.',
      'Rye doughs stay sticky because rye lacks the gluten to trap gas, so pan loaves and wet hands beat any attempt at a free-standing boule.',
      'A banneton dusted with rice flour releases the shaped dough cleanly because rice flour absorbs surface moisture without forming gluten.'
    ]
  },
  {
    id: 'rust-async',
    domains: ['tokio.rs', 'docs.rs', 'rust-lang.org', 'without.boats', 'fasterthanli.me'],
    titles: [
      'Tokio runtime multi-thread scheduler internals', 'Pin and Unpin explained for async Rust',
      'Cancellation safety in select loops', 'Async traits and dynamic dispatch overhead',
      'Structured concurrency with JoinSet', 'Blocking calls inside async contexts',
      'Waker contracts and manual Future impls', 'Send bounds on spawned tasks',
      'io_uring backends for async runtimes', 'Comparing tokio and smol executors',
      'Backpressure with bounded mpsc channels', 'Async drop and linear types debate',
      'Work stealing and task budgets in Tokio', 'Streams and async iterators stabilization', 'Timer wheels in async runtimes'
    ],
    sentences: [
      'A future in Rust does nothing until it is polled, so dropping it is cancellation and every await point is a place the task can simply stop.',
      'The Tokio multi-thread runtime uses a work-stealing scheduler where each worker owns a local queue and steals from siblings when idle.',
      'Pin exists because self-referential futures hold pointers into their own state machine, and moving them would invalidate those pointers.',
      'Calling a blocking function inside an async task starves the executor, so CPU-heavy work belongs in spawn_blocking or a rayon pool.',
      'Cancellation safety means a future can be dropped at an await point without losing data, which many channel recv implementations guarantee.',
      'The Waker is how a leaf future tells the executor its task is ready to make progress, and losing a waker means the task hangs forever.',
      'Spawned tasks must be Send because the work-stealing scheduler may move them between worker threads at any await point.',
      'Bounded channels provide backpressure by making senders await when the buffer is full, which keeps a fast producer from exhausting memory.',
      'An async function compiles into a state machine enum whose variants hold the local variables alive across each await point.',
      'Select races multiple futures and drops the losers, so any branch holding a partially received message must be cancellation safe.',
      'JoinSet gives structured concurrency by tying child task lifetimes to a scope, so a failed parent aborts the whole group cleanly.',
      'Task budgets in Tokio force a yield after 128 consecutive polls so one busy task cannot monopolize its worker thread.',
      'The io_uring backend batches syscalls through a shared ring buffer, cutting per-operation overhead for high-throughput file and socket work.',
      'Async trait methods box their returned futures unless you use return position impl trait, which adds an allocation per call on hot paths.',
      'Timer wheels bucket deadlines into hierarchical slots so millions of sleeps cost near-constant time per tick instead of a heap operation each.'
    ]
  },
  {
    id: 'mars-sample-return',
    domains: ['nasa.gov', 'esa.int', 'planetary.org', 'spacenews.com'],
    titles: [
      'Mars Sample Return architecture redesign options', 'Perseverance sample tube depot at Three Forks',
      'Mars Ascent Vehicle propulsion trade study', 'ESA Earth Return Orbiter status',
      'Sample receiving facility biosafety requirements', 'Jezero crater delta stratigraphy findings',
      'Cost overruns reshape MSR mission timeline', 'Orbiting Sample container capture mechanism',
      'Backward planetary protection for returned samples', 'Commercial lander proposals for MSR',
      'Sealed tube tungsten shielding design', 'Regolith versus rock core sample science value',
      'MAV solid motor cold temperature qualification', 'Rendezvous and capture in Mars orbit', 'Sample caching strategy on the delta front'
    ],
    sentences: [
      'Mars Sample Return needs three coordinated elements, a fetch architecture on the surface, an ascent vehicle to Mars orbit, and an Earth return orbiter.',
      'Perseverance dropped ten titanium sample tubes at the Three Forks depot as insurance against the rover failing before the retrieval lander arrives.',
      'The Mars Ascent Vehicle must survive years of Martian cold and then fire a two-stage solid motor to loft the sample container into orbit.',
      'The Orbiting Sample container is a football-sized sphere that the Earth Return Orbiter must detect, chase down, and capture autonomously in Mars orbit.',
      'Backward planetary protection treats returned Mars material as potentially biohazardous until proven sterile, requiring a biosafety level four receiving facility.',
      'Jezero crater was chosen because its ancient river delta concentrates fine-grained sediments that are the best candidates for preserving biosignatures.',
      'Independent review boards flagged the mission cost climbing toward eleven billion dollars, triggering an architecture rethink and industry studies.',
      'Sample tubes are hermetically sealed on the surface because any exchange with the Earth atmosphere would compromise trapped Martian gas measurements.',
      'The rocky core samples record aqueous mineral history while regolith and atmospheric samples constrain present-day surface processes and dust hazards.',
      'A break-the-chain maneuver separates hardware that touched Mars from the container returned to Earth, keeping the outside of the capsule clean.',
      'ESA supplies the Earth Return Orbiter with electric propulsion that spirals down to a low Mars orbit for rendezvous and then climbs back for Earth injection.',
      'Landing a fetch system on the delta requires terrain-relative navigation because the science-rich terrain is scattered with lander-killing boulders.',
      'The carbonate signatures along the crater margin suggest a closed-basin lake chemistry that could have concentrated organics as waters evaporated.',
      'Solid rocket motors qualified for minus forty storage still lose grain integrity over multiple Martian winters, driving heater power budgets on the lander.',
      'The returned samples would anchor the absolute chronology of Mars by giving laboratories datable material tied to a mapped stratigraphic column.'
    ]
  },
  {
    id: 'attention-research',
    domains: ['claude.ai', 'arxiv.org', 'nature.com', 'psycnet.apa.org', 'gwern.net'],
    titles: [
      'Attention residue after task switching', 'Sustained attention and vigilance decrement studies',
      'Information foraging theory and patch-leaving', 'Media multitasking and working memory correlates',
      'Mind wandering sampling methodology critique', 'Attention restoration theory evidence review',
      'Task switching costs in interruption research', 'Notification-driven fragmentation of knowledge work',
      'Flow states and undistracted deep work literature', 'Eye tracking measures of reading attention',
      'Cognitive load and multitasking performance', 'Interruption recovery time field studies',
      'Attention economics and the cost of switching', 'Salience networks and exogenous capture', 'Measuring attention with behavioral traces'
    ],
    sentences: [
      'Attention residue describes how thoughts about a prior task persist after switching, degrading performance on the new task even when time pressure is absent.',
      'The vigilance decrement shows sustained attention declining measurably within twenty to thirty minutes of continuous monitoring work.',
      'Information foraging theory models browsing as patch-leaving decisions, where a reader abandons a source when its expected information rate drops below the environment average.',
      'Field studies of knowledge workers find that a single interruption can add over twenty minutes before full task resumption.',
      'Heavy media multitaskers show worse filtering of irrelevant stimuli in laboratory tasks, though the causal direction remains contested.',
      'Experience sampling reveals mind wandering occupying a large fraction of waking thought, with rates sensitive to task engagement and sleep.',
      'Task switch costs appear even with predictable switches, suggesting reconfiguration of task sets carries an obligatory time penalty.',
      'Behavioral trace data like application logs and browser histories offer ecological measures of attention that self-report diaries systematically miss.',
      'Interruption experiments distinguish external notifications from internal self-interruptions, and self-interruptions rise when external ones are suppressed.',
      'Attention restoration theory attributes recovery effects to soft fascination in natural environments, though replication attempts show mixed effect sizes.',
      'Fragmented work sessions correlate with higher stress and lower self-rated productivity in diary studies of software developers.',
      'The salience network reorients processing toward unexpected stimuli, which notification designers exploit with variable reward schedules.',
      'Longer uninterrupted blocks predict subjective flow reports better than total hours worked in daily reconstruction studies.',
      'Switch density measured from event logs correlates with end-of-day fatigue ratings independent of total workload.',
      'Reading researchers use fixation duration and regression rates to separate skimming from deep comprehension in eye tracking corpora.'
    ]
  },
  {
    id: 'index-fund-fees',
    domains: ['bogleheads.org', 'morningstar.com', 'investopedia.com', 'etf.com'],
    titles: [
      'Expense ratio impact over thirty years', 'Total market versus S&P 500 tracking differences',
      'Tax loss harvesting with index ETFs', 'Securities lending revenue in cheap funds',
      'Tracking error sources in international index funds', 'Three fund portfolio rebalancing bands',
      'ETF bid ask spreads versus mutual fund NAV', 'Fee compression trends across index providers',
      'Dividend drag in synthetic replication ETFs', 'Index reconstitution front running costs',
      'Asset location for bond index funds', 'Comparing zero fee funds fine print', 'Vanguard patent expiry and ETF share classes',
      'Factor tilts versus plain market cap weighting', 'Hidden costs beyond the expense ratio'
    ],
    sentences: [
      'A one percent expense ratio compounds into roughly a quarter of final wealth lost over a thirty year horizon compared with a five basis point fund.',
      'Tracking difference, not the published expense ratio, is the true cost of an index fund because it folds in lending revenue and replication frictions.',
      'Securities lending income lets some large index funds run effective costs near zero by lending hard-to-borrow shares to short sellers.',
      'Total market funds hold thousands of small caps that the S&P 500 misses, though the return difference has been small over long windows.',
      'Tax loss harvesting swaps a fund for a similar but not substantially identical index to realize losses without leaving the market.',
      'Index reconstitution days create predictable trading that costs cap-weighted funds a few basis points as arbitrageurs front run additions.',
      'The three fund portfolio pairs a domestic total market fund, an international fund, and a bond fund, rebalanced with five percent tolerance bands.',
      'ETF investors pay bid ask spreads and premiums to net asset value, costs invisible in mutual fund purchases executed at closing NAV.',
      'Bond index funds belong in tax-advantaged accounts because their income is taxed as ordinary rates rather than qualified dividends.',
      'Synthetic replication ETFs use total return swaps that avoid withholding tax drag but add counterparty exposure regulated by collateral rules.',
      'Fee wars pushed core index products under five basis points while thematic and factor products keep charging ten times more.',
      'Zero fee funds recover costs through lending revenue and by serving as gateways into paid advisory relationships.',
      'Market cap weighting is self-rebalancing because winners grow their own weight without any trading by the fund.',
      'Fund domicile decides dividend withholding treatment, which can cost an international index tracker thirty basis points annually.',
      'Cash drag from handling daily flows is a hidden cost mutual funds carry that in-kind ETF creation largely avoids.'
    ]
  },
  {
    id: 'ollama-quantization',
    domains: ['ollama.com', 'github.com', 'huggingface.co', 'reddit.com'],
    titles: [
      'GGUF quantization formats compared', 'K-quants versus legacy quant quality',
      'Running 12B models on 18GB unified memory', 'KV cache memory scaling with context length',
      'Importance matrix calibration for low bit quants', 'Metal backend performance on Apple silicon',
      'Perplexity benchmarks across quant levels', 'Q4_K_M as the default sweet spot',
      'Offloading layers between GPU and CPU', 'Flash attention memory savings in llama.cpp',
      'Modelfile parameters and context window settings', 'Embedding models under quantization',
      'Speculative decoding with draft models', 'VRAM estimation formulas for GGUF', 'Serving concurrent requests with one model'
    ],
    sentences: [
      'GGUF packs quantized weights with tokenizer and metadata in one file, replacing the older GGML format across the llama.cpp ecosystem.',
      'K-quants divide weight blocks into superblocks with separate scale factors, holding quality far better than legacy round-to-nearest at four bits.',
      'A twelve billion parameter model at Q4_K_M occupies roughly eight gigabytes, leaving headroom for KV cache on an eighteen gigabyte machine.',
      'KV cache grows linearly with context length and layer count, and a sixteen thousand token window can add gigabytes on top of the weights.',
      'The importance matrix guides which weights keep precision during quantization by sampling activations over a calibration corpus.',
      'Perplexity rises only slightly from eight bit down to Q4_K_M, then climbs steeply below three bits where coherence visibly degrades.',
      'Apple silicon shares memory between CPU and GPU, so the Metal backend runs models that would need a large discrete VRAM card elsewhere.',
      'Ollama keeps a model resident for a keep alive interval after each request, and tuning it prevents two large models from being loaded at once.',
      'Flash attention computes softmax in tiles without materializing the full attention matrix, cutting memory at long context substantially.',
      'Setting num_ctx per request matters because the default four thousand token window silently truncates long prompts.',
      'Embedding models quantize poorly below eight bits because retrieval quality depends on fine-grained vector geometry.',
      'Speculative decoding drafts tokens with a small model and verifies them in one pass of the large model, trading compute for latency.',
      'Layer offloading splits a model between GPU and system memory, and a single misplaced layer boundary can halve tokens per second.',
      'Grouped query attention shrinks the KV cache by sharing key and value heads, which is why newer models scale context so cheaply.',
      'Concurrent requests share weights but not KV cache, so parallelism is bounded by cache memory rather than model size.'
    ]
  },
  {
    id: 'mechanical-keyboards',
    domains: ['geekhack.org', 'keebtalk.com', 'switchandclick.com', 'drop.com'],
    titles: [
      'Linear versus tactile switch force curves', 'Gasket mount versus tray mount typing feel',
      'Lubing switches with 205g0 guide', 'Keycap profiles compared Cherry versus SA',
      'Group buy etiquette and vendor risk', 'Stabilizer tuning to kill rattle',
      'PBT versus ABS keycap shine over time', 'QMK layers and home row mods',
      'Plate materials brass polycarbonate aluminum', 'Hot swap sockets versus soldered builds',
      'Foam mods and case resonance', 'Spring swapping for lighter actuation', 'Film fitting on loose switch housings',
      'Split ergonomic boards learning curve', 'Sound test methodology and microphone bias'
    ],
    sentences: [
      'Linear switches travel smoothly from top to bottom while tactiles add a bump near actuation that typists use as a landing cue.',
      'A gasket mounted plate floats on silicone strips, flexing under bottom-out and softening the harshness a tray mount transmits to the case.',
      'Thin coats of thick lubricant on switch rails remove scratch without drowning the spring, and over-application deadens tactile bumps.',
      'Cherry profile keycaps sit lower with sculpted rows for speed, while SA rows tower high and give a retro typewriter aesthetic and sound.',
      'Rattly stabilizers ruin an otherwise clean build, and the fix is holee modding the wire contact points and balancing both stems.',
      'PBT plastic resists finger oil shine for years while ABS develops gloss quickly but permits crisper doubleshot legends.',
      'Home row mods place shift and control under resting fingers through hold-tap behavior, trading a learning curve for reduced pinky strain.',
      'Brass plates ring bright and stiff, polycarbonate flexes deep and muted, and the plate choice changes sound more than most foam mods.',
      'Hot swap sockets let you change switches without a soldering iron but limit plate thickness choices and add slight stem wobble.',
      'Case foam absorbs hollowness but too much of it flattens the sound signature that distinguishes premium boards.',
      'Spring weight is measured at bottom-out, so a sixty gram progressive spring can feel lighter at actuation than a fifty five gram linear one.',
      'Switch films close tolerance gaps between housing halves, tightening the sound of vintage molds with loose top housings.',
      'Group buys run months from interest check to delivery, and vendor selection matters more than keycap renders when delays hit.',
      'Split boards force true touch typing because each hand can no longer poach keys across the center column.',
      'Sound tests mislead when microphones sit centimeters from the board, exaggerating clack that a normal sitting position never hears.'
    ]
  },
  {
    id: 'marathon-training',
    domains: ['runnersworld.com', 'strava.com', 'trainingpeaks.com', 'letsrun.com'],
    titles: [
      'Building weekly mileage without injury', 'Threshold versus VO2max interval sessions',
      'Long run fueling with carbohydrate targets', 'Marathon pacing and negative splits',
      'Zone two base training evidence', 'Taper length and volume reduction',
      'Shin splints and cadence adjustments', 'Race day carb loading protocols',
      'Heart rate drift on long runs', 'Choosing daily trainers versus super shoes',
      'Strength work for distance runners', 'Recovery weeks and supercompensation', 'Hydration and electrolyte planning for hot marathons',
      'Treadmill grade to simulate outdoor effort', 'Predicting marathon time from half splits'
    ],
    sentences: [
      'The ten percent rule for weekly mileage growth is a rough guide, and down weeks every fourth week protect connective tissue that adapts slower than aerobic fitness.',
      'Zone two runs feel embarrassingly slow but build mitochondrial density and fat oxidation that anchor the final miles of a marathon.',
      'Threshold intervals at one hour race effort raise the lactate turn point, the single best predictor of marathon pace for trained runners.',
      'Taking in sixty to ninety grams of carbohydrate per hour during long runs trains the gut to absorb race day fueling without distress.',
      'A negative split marathon requires starting slower than goal pace feels, banking restraint rather than time in the first ten kilometers.',
      'The taper cuts volume forty to sixty percent over two to three weeks while keeping intensity, letting fatigue clear without losing sharpness.',
      'Cardiac drift on a steady long run shows as rising heart rate at constant pace and marks the aerobic durability that marathon training targets.',
      'Increasing cadence a few percent shortens overstride and lowers tibial shock, a common prescription for recurring shin pain.',
      'Carbon plated super shoes return measurable percent-level economy gains but concentrate load on calves that daily trainers spread out.',
      'Carb loading for two days at ten grams per kilogram body weight fills glycogen stores that hold roughly ninety minutes of race effort.',
      'Heavy lifting twice a week improves running economy through tendon stiffness without adding meaningful muscle mass.',
      'The half marathon time doubled plus ten minutes rule underestimates the fade of runners with low weekly volume.',
      'Sweat rate testing on training runs lets you plan fluid intake instead of guessing at crowded aid stations.',
      'One percent treadmill grade compensates for missing air resistance at easy paces but overcorrects during slow recovery jogs.',
      'Supercompensation happens in the recovery window after hard blocks, which is why consecutive quality days blunt adaptation for most amateurs.'
    ]
  },
  {
    id: 'victorian-literature',
    domains: ['gutenberg.org', 'britannica.com', 'jstor.org', 'victorianweb.org'],
    titles: [
      'Serialization economics of Dickens novels', 'Middlemarch and the marriage plot subversion',
      'Sensation fiction and the 1860s reading public', 'Gothic revival in Bronte novels',
      'The three volume novel and circulating libraries', 'Realism versus romance in Victorian criticism',
      'Industrial novels and the condition of England', 'Tennyson and the dramatic monologue form',
      'New Woman fiction of the 1890s', 'Illustrated editions and Phiz plates',
      'Empire and the adventure romance', 'Fallen woman narratives and moral reform', 'Wilkie Collins and detective plotting',
      'Hardy Wessex and rural decline', 'Periodical culture and review criticism'
    ],
    sentences: [
      'Dickens wrote for monthly parts, and the serial format shaped his plotting with cliffhanger installments and characters recapped for readers months apart.',
      'The circulating libraries enforced the expensive three volume format for decades because triple deckers tripled lending revenue per title.',
      'Middlemarch treats marriage not as a comic ending but as the beginning of moral education, following Dorothea past the wedding that a conventional plot would close on.',
      'Sensation novels of the 1860s moved crime from distant castles into respectable drawing rooms, scandalizing critics who saw nerves replacing morals.',
      'The dramatic monologue lets Browning and Tennyson voice compromised speakers whose self-justification exposes what they cannot see about themselves.',
      'Condition of England novels like North and South stage industrial conflict through romance plots that reconcile masters and workers symbolically.',
      'Jane Eyre imports gothic machinery, the madwoman, the ruined hall, the uncanny laugh, into a governess story about moral independence.',
      'Wilkie Collins built The Moonstone from multiple unreliable narrators, a structure detective fiction inherited as the assembled testimony plot.',
      'The New Woman fiction of the 1890s debated bicycles, latchkeys, and university education as emblems of female independence.',
      'Hardy mapped a half-real Wessex whose agricultural decline registers the railway and market forces dissolving rural custom.',
      'Victorian periodicals paid by the page and their anonymous reviewing culture let critics savage rivals without attribution.',
      'The fallen woman plot demanded death or emigration for its heroine, and novelists negotiated reader sympathy against that punitive convention.',
      'Illustration was integral to serial publication, and readers met Pickwick through Phiz plates before the text described him.',
      'Adventure romances by Haggard and Stevenson exported domestic anxieties to imperial frontiers where English character could be tested.',
      'George Eliot defended realism as extending sympathy to commonplace lives that romance would find beneath notice.'
    ]
  },
  {
    id: 'kubernetes-networking',
    domains: ['kubernetes.io', 'cilium.io', 'tigera.io', 'learnk8s.io'],
    titles: [
      'Service ClusterIP to pod routing internals', 'CNI plugin comparison Cilium Calico Flannel',
      'eBPF replacing kube-proxy iptables', 'NetworkPolicy default deny patterns',
      'Ingress versus Gateway API migration', 'DNS resolution flow inside a cluster',
      'Pod to pod encapsulation VXLAN versus native routing', 'LoadBalancer services on bare metal with MetalLB',
      'Debugging CoreDNS latency spikes', 'Multi-cluster service meshes',
      'Egress gateways and NAT behavior', 'Headless services and stateful sets', 'Conntrack table exhaustion incidents',
      'Topology aware routing and zone spillover', 'Sidecarless mesh with ambient mode'
    ],
    sentences: [
      'A ClusterIP is a virtual address that never appears on any interface; kube-proxy programs iptables or IPVS rules that rewrite it to a backend pod IP.',
      'The CNI plugin assigns each pod a routable IP and wires its network namespace, and the choice decides whether traffic is encapsulated or natively routed.',
      'Cilium replaces kube-proxy with eBPF programs attached at the socket and XDP layers, cutting the per-packet cost of large iptables chains.',
      'NetworkPolicies are additive allowlists, so a default deny policy per namespace is the only way to make omissions fail closed.',
      'Cluster DNS appends search domains, so a single unqualified lookup can fan out into five queries and amplify CoreDNS load.',
      'VXLAN encapsulation costs about fifty bytes of overhead per packet and complicates MTU tuning, which is why native routing is preferred when the underlay allows it.',
      'The Gateway API splits role concerns into GatewayClass, Gateway, and HTTPRoute so platform teams and app teams stop sharing one Ingress resource.',
      'MetalLB answers ARP for service IPs in layer two mode, which fails over slowly because it depends on gratuitous ARP propagation.',
      'Headless services skip the virtual IP and return pod addresses directly, which stateful sets use for stable per-replica DNS names.',
      'Conntrack exhaustion silently drops new flows once the table fills, and high-churn services with short-lived connections get there fast.',
      'Topology aware hints keep traffic in the local zone until endpoint imbalance forces spillover, trading latency for even load.',
      'An egress gateway gives pods a stable source IP for external allowlists by routing outbound flows through dedicated nodes.',
      'Ambient mesh moves mTLS and telemetry into per-node proxies instead of sidecars, removing the injection and upgrade burden per workload.',
      'Every packet between pods crosses network namespaces through veth pairs whose drops show up in node-level interface statistics.',
      'Service meshes retry failed requests transparently, which can amplify outages when retry storms multiply load on a struggling backend.'
    ]
  },
  {
    id: 'houseplant-care',
    domains: ['houseplantcentral.com', 'thespruce.com', 'reddit.com', 'gardeningknowhow.com'],
    titles: [
      'Monstera aerial roots and moss pole training', 'Diagnosing yellow leaves overwatering versus nitrogen',
      'Fungus gnat control with bottom watering', 'Light meter readings for medium light plants',
      'Repotting rootbound pothos step by step', 'Humidity trays versus humidifiers for calatheas',
      'Propagating philodendron from node cuttings', 'Chunky aroid soil mix ratios',
      'Winter dormancy watering schedule changes', 'Spider mite early detection and treatment',
      'Fertilizer burn signs and flushing soil', 'Terracotta versus plastic pot moisture', 'Leggy growth and rotating toward light',
      'Water propagation to soil transition shock', 'Pet safe houseplant alternatives'
    ],
    sentences: [
      'Yellowing lower leaves with mushy stems point to overwatering, while uniform pale yellowing of new growth suggests nitrogen hunger instead.',
      'Fungus gnats breed in the top inch of moist soil, so letting that layer dry and watering from the bottom breaks their life cycle.',
      'A chunky aroid mix of bark, perlite, and coco coir drains in seconds, giving roots the oxygen that dense potting soil suffocates.',
      'Monstera aerial roots seek surfaces to climb, and a damp moss pole persuades the plant to produce larger fenestrated leaves.',
      'Most medium light plants want two hundred to four hundred foot candles, which a north window misses and a sheer-curtained south window exceeds.',
      'Roots circling the pot base mean it is time to size up one container width, not several, because excess soil holds water the roots cannot reach.',
      'Node cuttings need a visible bump where the leaf meets the stem, since roots emerge from the node and a bare internode simply rots.',
      'Calatheas crisp at the edges below fifty percent humidity, and a pebble tray raises local humidity a few points at best.',
      'Winter light drops cut photosynthesis so watering frequency should fall by half even when indoor heating dries the pot surface quickly.',
      'Fine webbing between leaf and stem betrays spider mites already established, and a weekly shower plus miticide rotation knocks them back.',
      'White crust on the soil surface is accumulated fertilizer salt, flushed by running water through the pot until it drains freely several times.',
      'Terracotta wicks moisture through its walls and suits overwaterers, while plastic holds moisture for the chronically forgetful.',
      'Leggy stretched growth with long internodes is a light deficit signal that no fertilizer schedule can fix.',
      'Water-rooted cuttings grow brittle water roots that partially die back on soil transfer, so early transplanting shortens the sulk.',
      'True lilies and sago palms are dangerously toxic to cats, and spider plants or parlor palms cover the same aesthetic safely.'
    ]
  },
  {
    id: 'grid-batteries',
    domains: ['canarymedia.com', 'utilitydive.com', 'nrel.gov', 'iea.org'],
    titles: [
      'Four hour lithium storage economics', 'Iron air batteries for multiday storage',
      'Battery participation in frequency regulation markets', 'LFP versus NMC chemistry for stationary storage',
      'Solar plus storage hybrid interconnection queues', 'Sodium ion cells entering grid pilots',
      'Storage capacity market accreditation debates', 'Thermal runaway safety standards for BESS',
      'Second life EV batteries in stationary racks', 'Long duration storage cost targets',
      'Grid forming inverters and black start', 'Curtailment reduction with co-located storage', 'Vanadium flow battery duration scaling',
      'Battery augmentation planning over project life', 'Interconnection reform and storage as transmission'
    ],
    sentences: [
      'Four hour lithium systems dominate new grid storage because capacity markets credit them near fully while costs fell under two hundred dollars per kilowatt hour.',
      'Iron air chemistry trades round trip efficiency near fifty percent for hundred hour duration at a fraction of lithium cost per stored kilowatt hour.',
      'Batteries earn the most in frequency regulation early on, but those shallow markets saturate quickly as storage fleets grow.',
      'LFP cells took over stationary storage because they tolerate full depth cycling and resist thermal runaway better than nickel chemistries.',
      'Flow batteries scale duration by adding electrolyte tanks while power stays fixed by stack size, decoupling the two cost drivers.',
      'Storage capacity accreditation is shifting to effective load carrying capability, which discounts batteries as penetration rises and net peaks lengthen.',
      'Co-locating storage with solar shares interconnection capacity and captures clipped energy that would otherwise be curtailed at the inverter.',
      'Grid forming inverters let a battery plant set voltage and frequency reference, enabling black start services that only synchronous machines provided before.',
      'Cell degradation forces augmentation planning, adding racks in later years to hold contracted capacity as original cells fade.',
      'Second life EV packs carry heterogeneous degradation that complicates rack-level battery management more than cheap new LFP cells justify.',
      'Sodium ion cells promise freedom from lithium and copper price swings, with pilots accepting lower energy density for stationary use.',
      'NFPA 855 spacing and deflagration venting rules reshaped BESS enclosure design after early container fires.',
      'Multiday storage competes against gas peakers on the cost of the last ten percent of reliability, not on average energy price.',
      'Batteries operating as transmission assets defer wire upgrades, but market rules struggle with one asset earning both regulated and merchant revenue.',
      'Interconnection queues holding thousands of hybrid projects pushed regulators toward cluster studies and readiness deposits.'
    ]
  }
];

const AMBIGUOUS_FILLER = [
  'The comments section debated the methodology at length without reaching any conclusion.',
  'A follow up post promised benchmarks that never materialized.',
  'Several readers shared loosely related personal anecdotes.',
  'The author linked a dozen tangential resources for further reading.',
  'An update at the top notes that much of this information may be outdated.',
  'The thread wandered between three unrelated questions from different posters.',
  'A moderator locked the discussion after it drifted off topic.',
  'The page aggregates snippets from many sources with little connecting text.'
];

const JUNK_PAGES = [
  { title: 'Sign in', domain: 'sso.example-corp.com', path: '/login', text: '' },
  { title: '', domain: 'cdn.trackerhub.net', path: '/pixel/9f8e', text: '' },
  { title: 'Redirecting...', domain: 'link.shortener.example', path: '/r/abc123', text: 'You are being redirected.' },
  { title: 'Just a moment...', domain: 'gateway.cloudguard.example', path: '/challenge', text: 'Checking your browser before accessing the site.' },
  { title: 'Session expired', domain: 'portal.example-corp.com', path: '/session/expired', text: 'Your session has expired. Please sign in again.' },
  { title: '404 Not Found', domain: 'files.example-mirror.org', path: '/missing/doc', text: 'The requested resource was not found on this server.' },
  { title: 'Untitled', domain: 'pastebin-like.example', path: '/raw/x1', text: 'lorem ipsum dolor sit amet consectetur adipiscing elit' },
  { title: 'Loading', domain: 'app.spinner.example', path: '/dashboard', text: 'Loading application shell.' },
  { title: 'Verify your email', domain: 'mailer.example-corp.com', path: '/verify', text: 'Click the button below to verify your email address.' },
  { title: 'Print preview', domain: 'docs.example-mirror.org', path: '/print/preview', text: 'Preparing document for printing.' },
  { title: 'Sign in - continue', domain: 'auth.example-svc.io', path: '/signin/continue', text: '' },
  { title: 'Redirect notice', domain: 'redirect.example-svc.io', path: '/notice', text: 'The page you were on is trying to send you to another site.' },
  { title: '', domain: 'static.example-cdn.net', path: '/frame/empty', text: '' },
  { title: 'Two factor check', domain: 'auth.example-svc.io', path: '/2fa', text: 'Enter the code from your authenticator app.' },
  { title: 'Rate limited', domain: 'api-status.example.io', path: '/429', text: 'Too many requests. Try again later.' },
  { title: 'Cookie preferences', domain: 'consent.example-svc.io', path: '/cookies', text: 'Manage your cookie preferences for this site.' },
  { title: 'Maintenance', domain: 'status.example-mirror.org', path: '/maintenance', text: 'Scheduled maintenance in progress.' },
  { title: 'Thank you', domain: 'forms.example-svc.io', path: '/submitted', text: 'Your response has been recorded.' },
  { title: 'Popup closed', domain: 'oauth.example-svc.io', path: '/callback/done', text: 'You may now close this window.' },
  { title: 'New tab', domain: 'start.example-browser.org', path: '/newtab', text: '' }
];

// -------------------------------------------------------------- page builder
function composeText(sentences, minWords, maxWords) {
  const target = minWords + Math.floor(rand() * (maxWords - minWords));
  const out = [];
  let words = 0;
  let pool = shuffle(sentences);
  let i = 0;
  while (words < target) {
    if (i >= pool.length) { pool = shuffle(sentences); i = 0; }
    const sentence = pool[i++];
    out.push(sentence);
    words += sentence.split(/\s+/).length;
  }
  return out.join(' ');
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function buildPages() {
  const pages = [];
  const PER_TOPIC = 27; // 12 x 27 = 324 topical pages

  for (const topic of TOPICS) {
    for (let i = 0; i < PER_TOPIC; i++) {
      const title = topic.titles[i % topic.titles.length] + (i >= topic.titles.length ? ` part ${Math.floor(i / topic.titles.length) + 1}` : '');
      // attention-research is the llm_chat convergence topic (spec §7.3
      // topic C): its first pages live on claude.ai as conversations.
      const isChat = topic.id === 'attention-research' && i < 10;
      const domain = isChat ? 'claude.ai' : topic.domains[i % topic.domains.length];
      const path = isChat
        ? `/chat/00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        : `/${slugify(title)}`;
      pages.push({
        url: `https://${domain}${path}`,
        title: isChat ? `${title} - Claude` : title,
        domain,
        source: isChat ? 'llm_chat' : 'web',
        extractedText: composeText(topic.sentences, 200, 500),
        groundTruthTopic: topic.id
      });
    }
  }

  // ~40 ambiguous pages: blend two topics' sentences plus vague filler.
  for (let i = 0; i < 40; i++) {
    const a = TOPICS[i % TOPICS.length];
    const b = TOPICS[(i + 5) % TOPICS.length];
    const blended = shuffle([
      ...shuffle(a.sentences).slice(0, 3),
      ...shuffle(b.sentences).slice(0, 3),
      ...shuffle(AMBIGUOUS_FILLER).slice(0, 4)
    ]).join(' ');
    const domain = pick(['medium.com', 'news.ycombinator.com', 'reddit.com', 'substack.com']);
    pages.push({
      url: `https://${domain}/mixed/${i}-links-roundup`,
      title: pick([
        'Weekly links roundup', 'Assorted notes and bookmarks', 'Open thread',
        'What I read this month', 'Miscellany', 'Friday grab bag'
      ]) + ` #${i + 1}`,
      domain,
      source: 'web',
      extractedText: blended,
      groundTruthTopic: 'ambiguous'
    });
  }

  // 20 junk pages.
  JUNK_PAGES.forEach((junk, i) => {
    pages.push({
      url: `https://${junk.domain}${junk.path}`,
      title: junk.title,
      domain: junk.domain,
      source: 'web',
      extractedText: junk.text,
      groundTruthTopic: 'junk'
    });
  });

  return pages;
}

// ------------------------------------------------------------ visit schedule
// 28 days anchored so that day 8 is a DST spring-forward day (US 2026-03-08).
// Day numbers are 1-based; day 1 = 2026-03-01 local.
const ANCHOR = { year: 2026, month: 2, day: 1 }; // March 1 2026, local

function dayStartMs(dayNumber) {
  return new Date(ANCHOR.year, ANCHOR.month, ANCHOR.day + (dayNumber - 1), 0, 0, 0, 0).getTime();
}

function atTime(dayNumber, hour, minute) {
  return new Date(ANCHOR.year, ANCHOR.month, ANCHOR.day + (dayNumber - 1), hour, minute, 0, 0).getTime();
}

function buildVisits(pages) {
  const byTopic = new Map();
  for (const page of pages) {
    if (!byTopic.has(page.groundTruthTopic)) byTopic.set(page.groundTruthTopic, []);
    byTopic.get(page.groundTruthTopic).push(page);
  }
  const chatPages = byTopic.get('attention-research').filter(p => p.source === 'llm_chat');
  const webAttention = byTopic.get('attention-research').filter(p => p.source === 'web');

  const visits = [];
  let visitSeq = 0;
  const pushSession = (dayNumber, startHour, startMinute, sessionPages, gapMinutes) => {
    let t = atTime(dayNumber, startHour, startMinute);
    for (const page of sessionPages) {
      visits.push({
        visitId: `v${++visitSeq}`,
        url: page.url,
        title: page.title,
        visitTime: t,
        transition: 'link',
        source: page.source
      });
      t += (gapMinutes + rand() * 2) * 60000;
    }
  };

  const GAP_DAYS = new Set([15, 16, 17]);   // no browsing at all (spec §7.3)
  const LOW_DATA_DAY = 18;                  // ~5 minutes total
  const PAUSE_DAY = 23;                     // pause interval 14:00-17:00

  const rotating = TOPICS.filter(t => !['sourdough-baking', 'rust-async', 'attention-research'].includes(t.id));

  for (let day = 1; day <= 28; day++) {
    if (GAP_DAYS.has(day)) continue;

    if (day === LOW_DATA_DAY) {
      // Five one-minute-spaced visits ~= 4 min gaps + 1 min session end.
      const p = byTopic.get('rust-async');
      pushSession(day, 9, 0, [p[0], p[1], p[2], p[3], p[4]], 0.6);
      continue;
    }

    // Topic B: rust-async active daily.
    const rust = byTopic.get('rust-async');
    pushSession(day, 9, 30, shuffle(rust).slice(0, 5), 6);

    // Topic A: sourdough days 1-7, dormant 8-24, revived day 25.
    if (day <= 7 || day >= 25) {
      const sd = byTopic.get('sourdough-baking');
      pushSession(day, 19, 0, shuffle(sd).slice(0, 4), 5);
    }

    // Topic C: attention-research via llm_chat days 1-7, via web days 8-14.
    if (day <= 7) {
      pushSession(day, 14, 0, shuffle(chatPages).slice(0, 2), 8);
    } else if (day <= 14) {
      pushSession(day, 14, 0, shuffle(webAttention).slice(0, 3), 6);
    }

    // Two rotating topics per day for breadth.
    const r1 = rotating[day % rotating.length];
    const r2 = rotating[(day + 3) % rotating.length];
    pushSession(day, 11, 0, shuffle(byTopic.get(r1.id)).slice(0, 4), 5);
    pushSession(day, 16, 0, shuffle(byTopic.get(r2.id)).slice(0, 3), 5);

    // Sprinkle ambiguous and junk pages through the day.
    if (day % 2 === 0) pushSession(day, 12, 30, shuffle(byTopic.get('ambiguous')).slice(0, 2), 3);
    if (day % 3 === 0) pushSession(day, 13, 15, shuffle(byTopic.get('junk')).slice(0, 2), 1);

    // Day 23: two visits inside the pause interval that the pipeline must drop.
    if (day === PAUSE_DAY) {
      pushSession(day, 15, 0, shuffle(byTopic.get('index-fund-fees')).slice(0, 2), 10);
    }
  }

  // Midnight-spanning session: day 20 23:50 -> day 21 00:15.
  const kb = byTopic.get('mechanical-keyboards');
  pushSession(20, 23, 50, [kb[0], kb[1], kb[2]], 12);

  visits.sort((a, b) => a.visitTime - b.visitTime || a.visitId.localeCompare(b.visitId));

  return {
    anchorDay1: dayStartMs(1),
    days: 28,
    dstDay: 8,
    gapDays: [15, 16, 17],
    lowDataDay: LOW_DATA_DAY,
    midnightSession: { startDay: 20 },
    pauseIntervals: [{ start: atTime(PAUSE_DAY, 14, 0), end: atTime(PAUSE_DAY, 17, 0) }],
    design: {
      dormantTopic: 'sourdough-baking',
      dormantLastActiveDay: 7,
      revivedDay: 25,
      dailyTopic: 'rust-async',
      convergenceTopic: 'attention-research',
      convergenceDay: 8
    },
    visits
  };
}

// -------------------------------------------------------------------- write
const fixturesDir = path.join(__dirname, '..', 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });
const pages = buildPages();
const visitData = buildVisits(pages);
fs.writeFileSync(path.join(fixturesDir, 'pages.json'), JSON.stringify(pages, null, 1));
fs.writeFileSync(path.join(fixturesDir, 'visits.json'), JSON.stringify(visitData, null, 1));
console.log(`Wrote ${pages.length} pages (${pages.filter(p => p.groundTruthTopic === 'ambiguous').length} ambiguous, ${pages.filter(p => p.groundTruthTopic === 'junk').length} junk) and ${visitData.visits.length} visits`);

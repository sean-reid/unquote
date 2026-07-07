/**
 * Per-film transcript quality scoring. Transcripts vary from clean captions to
 * OCR wrecks (Memento-class l/I damage) and unpunctuated ASR dumps. The score
 * feeds a downrank flag so the worst tail can be treated cautiously downstream.
 */

// Roughly the thousand most common English words plus contraction forms as
// they appear after cue cleaning. Coverage, not curation: the dictionary hit
// rate only needs to separate healthy dialogue from OCR noise.
const COMMON_WORDS = new Set(
  (
    'the be to of and a in that have i it for not on with he as you do at this but his by from they we ' +
    'say her she or an will my one all would there their what so up out if about who get which go me ' +
    'when make can like time no just him know take people into year your good some could them see other ' +
    'than then now look only come its over think also back after use two how our work first well way ' +
    'even new want because any these give day most us is was are were been has had did said am might ' +
    'shall being having does gone got made went came took saw told asked left right down here where why ' +
    'again off away too very still never always something nothing anything everything someone anyone ' +
    'everyone somewhere nowhere really little big old great long own same such last next much many more ' +
    'few those before through between under against during without within along across behind beyond ' +
    'around near above below since until while both each every either neither another once twice place ' +
    'home house room door open close start stop end run walk talk speak call name find found keep let ' +
    'help show hear listen feel felt leave live stay wait watch turn move play put set sit stand bring ' +
    'brought buy pay meet read write remember forget understand mean happen seem believe hope wish need ' +
    'try love hate care mind matter thing stuff man woman men women boy girl child children kid kids ' +
    'friend family mother father brother sister son daughter wife husband baby guy guys lady sir madam ' +
    'mr mrs miss doctor captain officer money job car train plane ship boat road street city town ' +
    'country world earth water fire air night morning evening afternoon today tomorrow yesterday week ' +
    'month hour minute second moment life death dead alive kill killed die died dying head hand hands ' +
    'eye eyes face mouth heart blood body arm leg foot feet hair mine yours his hers ours theirs myself ' +
    'yourself himself herself itself ourselves themselves yes yeah yep no nope okay ok oh ah hey hello ' +
    'hi goodbye bye please thanks thank sorry excuse pardon well fine sure course maybe perhaps ' +
    'probably certainly definitely absolutely exactly almost enough quite rather pretty real true false ' +
    'wrong bad better best worse worst hard easy fast slow high low early late soon young small large ' +
    'short tall far deep dark light black white red blue green yellow cold hot warm cool nice happy sad ' +
    'angry afraid scared alone together maybe anybody nobody somebody everybody done doing making going ' +
    'coming looking taking getting giving telling saying seeing knowing thinking working trying living ' +
    'dying feeling talking walking running playing waiting watching listening eating drinking sleeping ' +
    'food eat ate drink drank sleep slept dream war peace god lord heaven hell devil king queen boss ' +
    'chief power point case fact question answer reason problem idea plan story word words truth lie ' +
    'lies news letter phone number school class book paper music song dance party game war gun knife ' +
    'shot shoot fight fought win won lose lost hold held caught catch throw threw drop fell fall break ' +
    'broke cut hit push pull carry send sent wear wore drive drove ride rode fly flew swim ran walked ' +
    "don't won't can't didn't doesn't isn't aren't wasn't weren't couldn't wouldn't shouldn't hasn't " +
    "haven't hadn't i'm i'll i've i'd you're you'll you've you'd he's he'll he'd she's she'll she'd " +
    "it's it'll we're we'll we've we'd they're they'll they've they'd that's there's here's what's " +
    "who's where's when's how's let's ain't gonna gotta wanna gotcha c'mon"
  )
    .split(/\s+/)
    .filter((w) => w.length > 0),
);

export interface FilmQuality {
  movieId: number;
  /** 0 to 100, higher is healthier. */
  score: number;
  punctuationDensity: number;
  dictionaryRate: number;
  ocrPerThousand: number;
  meanCueLength: number;
  cues: number;
  /** Transcript is likely not English dialogue (wrong-language source page). */
  nonEnglish: boolean;
}

const TERMINAL_CUE = /[.?!…]["'”’]?\s*$/;
const OCR_PATTERNS = [/[a-z]I[a-z]/g, /\bl\b/g, /[a-z]"[a-z]/g, /\bl'(?:m|ll|ve|d|re|s)\b/g];

/** Score one film from its raw (pre-cleaning) cues. */
export function scoreFilm(movieId: number, rawCues: string[]): FilmQuality {
  const cues = rawCues.length;
  let terminal = 0;
  let ocrHits = 0;
  let chars = 0;
  let tokens = 0;
  let known = 0;

  for (const cue of rawCues) {
    chars += cue.length;
    if (TERMINAL_CUE.test(cue)) terminal += 1;
    for (const pattern of OCR_PATTERNS) {
      pattern.lastIndex = 0;
      ocrHits += cue.match(pattern)?.length ?? 0;
    }
    for (const word of cue.toLowerCase().split(/[^a-z']+/)) {
      if (word.length === 0) continue;
      tokens += 1;
      if (COMMON_WORDS.has(word)) known += 1;
    }
  }

  const punctuationDensity = cues > 0 ? terminal / cues : 0;
  const dictionaryRate = tokens > 0 ? known / tokens : 0;
  const ocrPerThousand = cues > 0 ? (ocrHits / cues) * 1000 : 0;
  const meanCueLength = cues > 0 ? chars / cues : 0;

  // Healthy transcripts sit around 60-80% terminal cues, 55-75% dictionary
  // rate, near-zero OCR hits, 20-45 char cues. Each component maps to 0..1.
  const punctuationScore = Math.min(punctuationDensity / 0.6, 1);
  const dictionaryScore = Math.min(dictionaryRate / 0.55, 1);
  const ocrScore = Math.max(0, 1 - ocrPerThousand / 200);
  const lengthScore = meanCueLength >= 12 && meanCueLength <= 80 ? 1 : 0.5;

  const score =
    100 * (0.3 * punctuationScore + 0.3 * dictionaryScore + 0.3 * ocrScore + 0.1 * lengthScore);

  return {
    movieId,
    score: Math.round(score * 10) / 10,
    punctuationDensity: Math.round(punctuationDensity * 1000) / 1000,
    dictionaryRate: Math.round(dictionaryRate * 1000) / 1000,
    ocrPerThousand: Math.round(ocrPerThousand * 10) / 10,
    meanCueLength: Math.round(meanCueLength * 10) / 10,
    cues,
    // Healthy English dialogue sits well above 0.5; a transcript under 0.2
    // is another language regardless of how clean it looks otherwise.
    nonEnglish: tokens > 200 && dictionaryRate < 0.2,
  };
}

/** Flag the worst decile for downranking. Mutates nothing; returns flagged ids. */
export function downrankSet(qualities: FilmQuality[]): Set<number> {
  const sorted = [...qualities].sort((a, b) => a.score - b.score);
  const count = Math.floor(sorted.length / 10);
  return new Set(sorted.slice(0, count).map((q) => q.movieId));
}

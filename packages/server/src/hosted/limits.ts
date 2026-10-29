/*
 * The hosted scanner's tiers (spec section 8; plan rulings 6 and 9, ledger R6).
 * Both tiers crawl same-origin from the start URL; the tier sets the page cap,
 * and the API (never the client) picks the tier.
 */

export const TIER_NAMES = ['open', 'verified'] as const;
export type Tier = (typeof TIER_NAMES)[number];

export interface TierLimits {
  /** Pages scanned at most, the start page included. */
  maxPages: number;
  /** Largest PDF, uploaded or fetched by URL, in bytes. */
  pdfMaxBytes: number;
  /** PDFs with more pages are not scanned. */
  pdfMaxPages: number;
  /** The scan machine's wall-clock cap; the API destroys the machine past it. */
  wallClockMs: number;
  /** Largest report (reportJson, UTF-8) a scan may send back; past it the scan fails as too large. */
  reportMaxBytes: number;
}

/** "1 URL plus up to 5 same-origin pages, or 1 PDF up to 25 MB / 100 pages". */
export const OPEN_TIER = {
  maxPages: 6,
  pdfMaxBytes: 25 * 1024 * 1024,
  pdfMaxPages: 100,
  wallClockMs: 10 * 60_000,
  reportMaxBytes: 8 * 1024 * 1024,
} as const satisfies TierLimits;

/** "crawl up to 200 pages on that domain". */
export const VERIFIED_TIER = {
  maxPages: 200,
  pdfMaxBytes: 25 * 1024 * 1024,
  pdfMaxPages: 100,
  wallClockMs: 45 * 60_000,
  reportMaxBytes: 32 * 1024 * 1024,
} as const satisfies TierLimits;

export const TIERS: Readonly<Record<Tier, TierLimits>> = {
  open: OPEN_TIER,
  verified: VERIFIED_TIER,
};

/** A verify job's wall-clock cap (ledger R42): two fetches of 20 s each, with room to start. */
export const VERIFY_WALL_CLOCK_MS = 2 * 60_000;

/** Verify jobs taken per UTC day at most, out of the day's job cap (MAX_PER_DAY, jobs.ts). */
export const VERIFY_DAILY_CAP = 100;

/** After a check ends failed, how long before the same verification may start another machine. */
export const VERIFY_COOLDOWN_MS = 60_000;

/** A job's wall-clock cap: VERIFY_WALL_CLOCK_MS for a verify job, else its tier's. */
export const wallClockFor = (tier: Tier, verify = false): number =>
  verify ? VERIFY_WALL_CLOCK_MS : TIERS[tier].wallClockMs;

/**
 * Pages robots.txt may skip before a hosted crawl stops (4 times the page cap,
 * set explicitly rather than left to scanWeb's default): 24 open, 800 verified.
 */
export const maxPolicySkipsFor = (limits: TierLimits): number => 4 * limits.maxPages;

/**
 * The agent gives up this long before the tier's cap, so its "ran out of time"
 * result reaches the API before the API destroys the machine.
 */
export const TIMEOUT_MARGIN_MS = 30_000;

/**
 * How long the scan (or verification) may still run, elapsedMs after the agent
 * started: the job's cap less TIMEOUT_MARGIN_MS and the time already spent, at least 1 ms.
 */
export const timeLimitFor = (tier: Tier, elapsedMs: number, verify = false): number =>
  Math.max(1, wallClockFor(tier, verify) - TIMEOUT_MARGIN_MS - elapsedMs);

/** The largest report of any tier (the verified tier's reportMaxBytes), in bytes (UTF-8). */
export const MAX_REPORT_BYTES = VERIFIED_TIER.reportMaxBytes;

/*
 * The API machine's memory (ruling R50, final fix rounds 2 and 3). Kept reports and queued
 * PDFs are Buffers outside the V8 heap, and so is the raw result body being read; the text
 * decoded from it, the parsed report and its renderings are in the heap. The worst case:
 *   API_HEAP_MB 896 + retained budget 512 + UPLOADS_OFF_HEAP_MB 200
 *   + one raw verified result body (resultBodyMax('verified'), about 64 MiB)
 *   + downloads in flight (DOWNLOADS_IN_FLIGHT x DOWNLOAD_CHUNK_BYTES, 64 x 64 KiB = 4 MiB)
 *   + OVERHEAD_MB 150 = about 1826.1 MiB <= API_MEMORY_MB 2048.
 * The heap is at least 512 and at least 1.5 times MEASURED_PEAK_HEAP_MB, the peak heap of one
 * near-cap verified result in its worst (two-byte) shape (test/hosted-memory.measure.ts).
 * fly.toml's --max-old-space-size and [[vm]] memory name these numbers; a test checks that
 * they agree and that both rules hold.
 */
/**
 * The peak heap, in MiB, one near-cap verified result needs in its two-byte shape: the
 * larger of the smallest --max-old-space-size that completes it (366) and the highest
 * heapUsed sampled under a real heap (422), measured on Node 24.19.0 at a 32 MiB cap.
 */
export const MEASURED_PEAK_HEAP_MB = 422;
/** The API machine's memory in MiB (fly.toml [[vm]] memory = "2gb"). */
export const API_MEMORY_MB = 2048;
/** The API's V8 heap in MiB (fly.toml NODE_OPTIONS --max-old-space-size). */
export const API_HEAP_MB = 896;
/** Up to 4 uploads of 25 MiB read at once, about 2 copies each, outside the heap. */
export const UPLOADS_OFF_HEAP_MB = 200;
/** Node's own memory and the OS, beyond the heap and the Buffers above. */
export const OVERHEAD_MB = 150;

/** Report downloads of one job read at once; one more is refused (429). */
export const DOWNLOADS_PER_JOB = 2;
/** Report downloads read at once in all; one more is refused (429). */
export const DOWNLOADS_IN_FLIGHT = 64;
/** Retry-After, in seconds, for a download refused by either bound. */
export const DOWNLOAD_RETRY_S = 10;
/** Report downloads read at once per client rate key (IPv4 /32, IPv6 /64). */
export const DOWNLOADS_PER_NETWORK = 2;
/** Report downloads read at once per wider client network (IPv4 /24, IPv6 /48). */
export const DOWNLOADS_PER_WIDE = 4;
/** The longest any download may take to send; past its deadline it is ended and its place freed. */
export const DOWNLOAD_DEADLINE_MS = 120_000;
/**
 * A download's deadline for a body of `bytes`: 10 s plus 1 s per 256 KiB, at most
 * DOWNLOAD_DEADLINE_MS, so a stalled small download does not hold its place for long.
 */
export const downloadDeadlineFor = (bytes: number): number =>
  Math.min(DOWNLOAD_DEADLINE_MS, 10_000 + Math.ceil(bytes / (256 * 1024)) * 1_000);
/** A download is sent as views of the kept report this large: no copy is made. */
export const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

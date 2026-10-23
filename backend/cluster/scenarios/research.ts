import { listing, listPreview, outputsOf, pagePreview, plural } from "../plan.ts";
import type { Result, Scenario } from "../plan.ts";

// A grad student's literature review on on-device speech recognition. The
// papers, authors and numbers are made up for the demo; the three "sources"
// are canned search results with overlaps, like real indexes have.

type Paper = { id: string; title: string; authors: string; year: number; venue: string; method: string; dataset: string; wer: number; params: number; latencyMs: number; takeaway: string };
type Hit = { title: string; year: number; source: string };
type Summary = Pick<Paper, "title" | "year" | "method" | "dataset" | "wer" | "params" | "latencyMs" | "takeaway">;

const TOPIC = "on-device speech recognition";

export const PAPERS: Paper[] = [
  { id: "p1", title: "TinyConformer: Streaming ASR Under 10M Parameters", authors: "Okafor, Lin", year: 2025, venue: "Interspeech", method: "Pruned streaming Conformer", dataset: "LibriSpeech test-clean", wer: 3.9, params: 9.6, latencyMs: 48, takeaway: "Pruning attention heads keeps accuracy close to models 4x larger." },
  { id: "p2", title: "Int4 Whisper for Phone NPUs", authors: "Haddad, Ito, Greer", year: 2025, venue: "arXiv", method: "4-bit quantized Whisper-small", dataset: "LibriSpeech test-clean", wer: 4.6, params: 244, latencyMs: 210, takeaway: "Quantizing to 4 bits halves memory with under 0.5 WER loss, but latency stays high." },
  { id: "p3", title: "Keyword-First: Cascaded Wake Word and ASR", authors: "Brooks, Farah", year: 2024, venue: "ICASSP", method: "Wake-word gate plus small RNN-T", dataset: "Speech Commands + LibriSpeech", wer: 6.1, params: 18, latencyMs: 35, takeaway: "Running ASR only after a wake word cuts energy use by 70 percent." },
  { id: "p4", title: "Distilled RNN-T with Shared Encoders", authors: "Lindqvist, Abara", year: 2024, venue: "Interspeech", method: "Knowledge-distilled RNN-T", dataset: "LibriSpeech test-clean", wer: 4.3, params: 30, latencyMs: 62, takeaway: "Distillation from a 600M teacher gives the best accuracy for its size." },
  { id: "p5", title: "Federated Fine-Tuning of On-Device ASR", authors: "Castillo, Dang", year: 2025, venue: "arXiv", method: "Federated fine-tuning of a Conformer", dataset: "Private user speech (simulated)", wer: 5.2, params: 45, latencyMs: 70, takeaway: "Personalizing on the device lowers WER 12 percent for accented speakers without sending audio." },
  { id: "p6", title: "SpikeASR: Event-Driven Speech Recognition", authors: "Eriksen, Jansen", year: 2024, venue: "NeurIPS workshop", method: "Spiking neural network", dataset: "TIMIT", wer: 11.8, params: 4.1, latencyMs: 22, takeaway: "Very low power and latency, but accuracy is far behind." },
];

// What each source's search returns: some papers appear in more than one, with titles written differently.
const SOURCES: Record<string, Array<{ title: string; year: number }>> = {
  "arXiv (demo)": [
    { title: "Int4 Whisper for Phone NPUs", year: 2025 },
    { title: "Federated fine-tuning of on-device ASR", year: 2025 },
    { title: "TinyConformer: streaming ASR under 10M parameters", year: 2025 },
    { title: "Distilled RNN-T with Shared Encoders", year: 2024 },
  ],
  "ACL Anthology (demo)": [
    { title: "Distilled RNN-T With Shared Encoders", year: 2024 },
    { title: "Keyword-First: Cascaded Wake Word and ASR", year: 2024 },
    { title: "Int4 Whisper for phone NPUs", year: 2025 },
  ],
  "Interspeech + workshops (demo)": [
    { title: "TinyConformer: Streaming ASR Under 10M Parameters", year: 2025 },
    { title: "SpikeASR: Event-Driven Speech Recognition", year: 2024 },
    { title: "Keyword-first: cascaded wake word and ASR", year: 2024 },
  ],
};

// What a reader sees opening a paper: its title, authors, venue and the sentences that matter.
function paperPage(title: string) {
  const paper = PAPERS.find((entry) => normalize(entry.title) === normalize(title))!;
  return { url: `${paper.venue} ${paper.year} · ${paper.authors}`, lines: [paper.title, `We propose ${paper.method.toLowerCase()}.`, `Evaluated on ${paper.dataset}.`, `${paper.wer}% WER with ${paper.params}M parameters.`, `${paper.latencyMs} ms per utterance on a phone.`, paper.takeaway] };
}

const normalize = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const research: Scenario = {
  id: "research",
  audience: "Researcher",
  icon: "paper",
  title: "Find, read and compare papers",
  prompt: `Find recent papers on ${TOPIC}, read them, and tell me how they compare.`,
  data: {
    label: "Running on three demo paper indexes",
    items: ["Demo sources: arXiv, ACL Anthology and Interspeech look-alikes with 10 results", "Demo papers: 6 made-up papers with methods, datasets and results"],
  },
  stages: [
    {
      label: "Search three sources",
      short: "Search",
      icon: "search",
      plan: () => Object.entries(SOURCES).map(([source, hits]) => ({ skill: "search", instruction: `Search ${source.replace(" (demo)", "")} for papers on ${TOPIC} from 2024–2025`, label: `Search ${source.replace(" (demo)", "").split(" ")[0]}`, icon: "search" as const, preview: listPreview("search", hits.map((hit): [string, string] => [hit.title, String(hit.year)])), params: { source }, ms: 5000, meter: { verb: "Checked", noun: "results", total: hits.length } })),
    },
    {
      label: "Remove duplicates",
      short: "Dedupe",
      icon: "merge",
      plan: (done) => [{ skill: "dedupe", instruction: "Merge the three result lists and drop papers found twice", label: "Drop duplicates", icon: "merge", params: { hits: outputsOf<Hit[]>(done, "search").flat() }, ms: 2500, role: "orchestrator" }],
    },
    {
      label: "Read one paper per board",
      short: "Read",
      icon: "paper",
      plan: (done) =>
        outputsOf<Hit[]>(done, "dedupe")[0].map((hit) => ({ skill: "summarize", instruction: `Read "${hit.title}" and note its method, dataset and results`, label: hit.title.split(":")[0].split(" ").slice(0, 3).join(" "), icon: "paper" as const, preview: pagePreview("paper", [paperPage(hit.title)]), params: { title: hit.title }, ms: 5000, meter: { verb: "Read", noun: "sections", total: 5 } })),
    },
    {
      label: "Write the comparison",
      short: "Compare",
      icon: "doc",
      plan: (done) => [{ skill: "compare", instruction: `Compare the ${outputsOf(done, "summarize").length} papers and write a short synthesis`, label: "Compare papers", icon: "doc", preview: pagePreview("doc", [{ url: "Comparison", lines: outputsOf<Summary>(done, "summarize").map((paper) => `${paper.title.split(":")[0]} · ${paper.wer}% · ${paper.latencyMs} ms`) }]), params: { papers: outputsOf<Summary[]>(done, "summarize") }, ms: 4000, meter: { verb: "Compared", noun: "papers", total: outputsOf(done, "summarize").length } }],
    },
  ],
  skills: {
    search: ({ source }: { source: string }) => {
      const hits: Hit[] = SOURCES[source].map((hit) => ({ ...hit, source }));
      return { found: { marks: hits.map((hit, row): [number, string] => [row, "on topic"]) }, summary: `${plural(hits.length, "paper")} from ${source.replace(" (demo)", "")}`, short: plural(hits.length, "paper"), data: hits };
    },
    dedupe: ({ hits }: { hits: Hit[] }) => {
      const unique = new Map<string, Hit>();
      for (const hit of hits) if (!unique.has(normalize(hit.title))) unique.set(normalize(hit.title), hit);
      const kept = [...unique.values()].sort((a, b) => b.year - a.year || a.title.localeCompare(b.title));
      return { summary: `${hits.length} results, ${kept.length} unique papers`, short: `${kept.length} unique`, data: kept };
    },
    summarize: ({ title }: { title: string }) => {
      const paper = PAPERS.find((entry) => normalize(entry.title) === normalize(title))!;
      const { method, dataset, wer, params, latencyMs, takeaway, year } = paper;
      return { found: { pages: [[`Method: ${method}`, `${wer}% WER on ${dataset.split(" ")[0]}`, `${params}M params · ${latencyMs} ms`]] }, summary: `${paper.title.split(":")[0]}: ${wer}% WER, ${params}M params`, short: `${wer}% WER`, data: { title: paper.title, year, method, dataset, wer, params, latencyMs, takeaway } };
    },
    compare: ({ papers }: { papers: Summary[] }) => {
      const byWer = [...papers].sort((a, b) => a.wer - b.wer);
      const fastest = [...papers].sort((a, b) => a.latencyMs - b.latencyMs)[0];
      const comparable = byWer.filter((paper) => paper.dataset === "LibriSpeech test-clean");
      const result: Result = {
        headline: `${byWer[0].title.split(":")[0]} is the most accurate (${byWer[0].wer}% WER at ${byWer[0].params}M parameters); ${fastest.title.split(":")[0]} is the fastest but least accurate.`,
        stats: [
          { value: String(papers.length), label: "papers compared" },
          { value: `${byWer[0].wer}%`, label: "best WER" },
          { value: `${fastest.latencyMs} ms`, label: "fastest" },
        ],
        sections: [
          {
            title: "How they compare",
            kind: "table",
            columns: ["Paper", "Year", "Method", "Dataset", "WER", "Size", "Latency"],
            rows: byWer.map((paper) => [paper.title, String(paper.year), paper.method, paper.dataset, `${paper.wer}%`, `${paper.params}M`, `${paper.latencyMs} ms`]),
          },
          {
            title: "Synthesis",
            kind: "text",
            body: `Of the ${plural(comparable.length, "paper")} tested on LibriSpeech test-clean, ${listing(comparable.map((paper) => `${paper.title.split(":")[0]} (${paper.wer}%)`))} show that small models now get close to large ones: pruning and distillation beat quantizing a big model when latency matters. ${fastest.title.split(":")[0]} trades accuracy for power. ${plural(papers.length - comparable.length, "paper uses", "papers use")} different data, so those numbers are not directly comparable. Open question for your review: none of them report results on noisy, far-field speech.`,
          },
          { title: "One line per paper", kind: "list", items: byWer.map((paper) => `${paper.title} (${paper.year}): ${paper.takeaway}`) },
        ],
      };
      return { found: { pages: [[`Most accurate: ${byWer[0].title.split(":")[0]}`, `Fastest: ${fastest.title.split(":")[0]}`]] }, summary: `Compared ${plural(papers.length, "paper")}`, short: "Table ✓", data: result };
    },
  },
};

# Open-source memory systems: how they write, merge, age and retrieve, and what Deskmates could try next

Date: 2026-10-14.
Status: research input, no decision. Asked for by the owner on 2026-10-14 (ruling 10 on issue #85): "research how open-source memory products do it (mem0, Letta/MemGPT, Zep/Graphiti, LangMem, Cognee, MemOS...) and revisit the overall logic, but run the current design for a while first".
Source: written from prior knowledge of the projects' documentation, papers and source as of mid-2026, without web access during writing. Builds on `m3-context-memory-research-2026-09-29.md` §3 and §4 (which surveyed Letta, LangMem, CrewAI, Google Memory Bank, OpenAI, Mem0, Graphiti, Anthropic stores, Claude Code, ChatGPT and OpenClaw at the level of scopes and write paths) and does not repeat its tables. Compares against ADR-0011 as amended through amendment 4 (owner rulings of 2026-10-14).

> **Verify against current upstream docs.** Every statement about a third-party project below is from memory and may be out of date or wrong in detail. Claims marked *(unverified)* are ones the author is least sure of. Benchmark numbers are quoted only as vendor claims, never as evidence; several vendors dispute each other's numbers, and LoCoMo itself has known answer-key defects (see the 2026-09-29 research doc §4). Before any item in §6 is built, re-read the upstream source of the system it borrows from.

Nothing in this document was run. It authorises nothing: memory integration preparation is authorised (owner amendment of 2026-10-05), a paid memory campaign is not, and the existing USD 3 campaign stays reserved for US stock.

## 1. The question

Deskmates's learned memory (ADR-0011) is deliberately deterministic where most of the field uses a model: the Gateway classifies, gates, deduplicates and supersedes learned items with pure functions in `contracts` (the imperative and do-not-learn classifiers, the lexical fact key of A7, the recency order of A9), and trust comes from the sidecar's taint tracking, never from the writing model. Amendment 4 as ruled on 2026-10-14 adds the first model judgement over existing notes: a cheap-model recheck that can renew a note (A28) and a daily organisation job that labels topics and proposes splits (A30 to A32).

The owner asked how other systems handle six things. Each section below answers per dimension rather than per product, because the products converge on a small number of patterns:

- (a) extraction and the write path: who decides what is stored, in the hot path or in the background;
- (b) deduplication;
- (c) conflicts and supersession: update and delete operations, temporal validity;
- (d) freshness, decay and forgetting;
- (e) retrieval: vector, keyword, graph, reranking, pinned core memory;
- (f) evaluation.

§2 summarises each system in a few lines. §3 goes dimension by dimension. §4 covers the security literature that bears on all of them. §5 compares with ADR-0011. §6 lists changes worth trying once the current design has produced traffic, each with a paired-evaluation plan.

## 2. The systems in brief

### 2.1 mem0

A memory layer for assistants keyed by `user_id`, `agent_id` and `run_id`. The write path is a two-step LLM pipeline (described in the mem0 paper, arXiv 2504.19413, and the source):

1. **Extraction.** An LLM reads the latest messages (plus a rolling conversation summary and recent messages as context) and returns a list of candidate "facts" as short sentences. A configurable custom prompt can restrict what counts as a fact.
2. **Update.** For each candidate, the top similar existing memories are retrieved by vector similarity, and an LLM chooses one operation: `ADD` (new memory), `UPDATE` (rewrite an existing memory, keeping its id), `DELETE` (remove a memory the candidate contradicts) or `NOOP`. The model sees existing memories with temporary integer ids to avoid hallucinated UUIDs.

Memories are stored in a vector store with metadata, plus a history table recording each operation (old and new text) per memory id. Retrieval is vector search over memories, optionally reranked, with metadata filters.

**Graph memory** (mem0g in the paper, "graph memory" in the product) additionally extracts entities and relations into a graph store (Neo4j, Memgraph and others). Relation conflicts are resolved by an LLM that marks old relations obsolete *(unverified whether they are deleted or flagged in current versions)*. Retrieval combines vector hits with graph neighbours.

Freshness: no built-in decay; `DELETE` is the forgetting mechanism, plus explicit API deletes and, in the hosted product, expiration dates on memories *(unverified)*. Evaluation: the paper reports LoCoMo results with an LLM judge against several baselines; the numbers are vendor-claimed and were publicly disputed by Zep and Letta.

### 2.2 Letta (formerly MemGPT)

An agent framework built around the MemGPT idea of an operating-system-like memory hierarchy (Packer et al., arXiv 2310.08560):

- **Core memory**: labelled text blocks (classically `persona` and `human`) pinned in the system prompt, with character limits. The agent edits them itself with tools (`core_memory_append`, `core_memory_replace`, later `memory_insert`, `memory_replace`, `memory_rethink` *(tool names vary by version, unverified)*). Blocks can be shared between agents.
- **Recall memory**: the full message history in a database, searchable by text and date.
- **Archival memory**: an agent-written vector store (`archival_memory_insert`, `archival_memory_search`).

The write decision is the agent's own, in the hot path, through tool calls. **Sleep-time agents** (2025) move memory work off the hot path: a second agent shares the primary agent's memory blocks and, between turns or on a schedule, reorganises them ("learned context"), so the primary agent answers faster and the memory gets more deliberate edits. Letta's later "context repositories" (git-backed memory files) are covered in the 2026-09-29 doc.

Dedup and conflicts are left to the agent's own judgement when it rewrites a block. No decay: the block size limit forces the agent to compress. Letta publishes the Letta Leaderboard and Context-Bench for model choice and argued (in a 2025 blog post) that a plain filesystem-plus-search agent scores well on LoCoMo, which questions what LoCoMo measures *(paraphrased, unverified)*.

### 2.3 Zep and Graphiti

Zep is a hosted memory service; Graphiti is its open-source core, a **temporal knowledge graph** (Rasmussen et al., arXiv 2501.13956):

- Input arrives as **episodes** (a message, a JSON document, a text chunk) with a reference time.
- An LLM extracts **entities** (nodes) and **facts** (edges, each a sentence with a relation type) from each episode, using recent episodes as context.
- **Entity resolution**: new entities are matched to existing ones by embedding and full-text search over names, then an LLM decides whether they are the same; duplicates are merged.
- **Edge deduplication and invalidation**: a new edge is compared with existing edges between the same entities (and semantically similar edges); an LLM decides whether it duplicates one or contradicts one. A contradicted edge is **not deleted**: its `invalid_at` is set (and `expired_at` on the system timeline).
- Every edge is **bi-temporal**: `valid_at` / `invalid_at` describe when the fact held in the world (extracted from the text when possible, otherwise the episode time), `created_at` / `expired_at` describe when the system believed it. Edges link back to the episodes they came from.
- **Communities** (clusters of entities, label-propagation in the paper) get LLM summaries, as a higher-level layer.

Retrieval is hybrid: cosine similarity on embeddings, BM25 full-text and graph breadth-first search from relevant nodes, fused by reciprocal rank fusion, maximal marginal relevance, node-distance or a cross-encoder reranker. No LLM call is needed at query time. Freshness is expressed by validity intervals rather than decay. The paper reports Deep Memory Retrieval (DMR, from MemGPT) and LongMemEval results (vendor-claimed).

### 2.4 LangMem (LangChain)

A library on top of the LangGraph store (namespaced key-value with optional vector index). It names three memory types: **semantic** (facts, as a collection of documents or a single profile document), **episodic** (past experiences, often as few-shot examples) and **procedural** (instructions, implemented as **prompt optimisation**: an optimiser rewrites the agent's system prompt from trajectories and feedback).

Two write paths:

- **Hot path**: memory tools (`manage_memory`, `search_memory`) the agent calls itself.
- **Background**: a memory manager / reflection executor that runs after a conversation goes quiet (debounced), extracts memories with an LLM and reconciles them with existing ones by asking the model to insert, update or delete (structured output over the existing memories). This is mem0's pattern as a library.

No built-in decay; consolidation and deletion are the model's choice. Evaluation is left to the application.

### 2.5 Cognee

An open-source "AI memory" engine organised as an **ECL pipeline** (extract, cognify, load): `add` ingests documents or text, `cognify` chunks, classifies and extracts entities and relations with an LLM into a graph store plus a vector store, and `search` offers several search types (chunk, summary, graph completion, insights, code and others). **Memify** *(2025, unverified in detail)* is a post-processing step that enriches an existing graph: derives rules or associations from it, prunes or strengthens nodes, adds embeddings. Feedback on answers can adjust weights *(unverified)*.

Dedup is by entity resolution during cognify (deterministic ids from normalised names plus model extraction). Conflicts: no first-class temporal invalidation comparable to Graphiti that the author is sure of *(unverified)*. Cognee has published evaluations on HotpotQA-style multi-hop QA with LLM judges (vendor-claimed).

### 2.6 MemOS

A "memory operating system" from MemTensor and collaborators (arXiv 2505.22101 and a longer 2507 version). It treats memory as a scheduled system resource with three kinds:

- **Plaintext memory**: text and graph memories (the "tree" textual memory organises items hierarchically with a graph).
- **Activation memory**: KV-cache of frequently used context, precomputed and injected.
- **Parametric memory**: LoRA-style weights.

The unit is a **MemCube**: content plus metadata (provenance, version, access control, lifecycle state, usage statistics). A **MemScheduler** moves items between kinds (for example, hot plaintext into activation memory) and handles lifecycle (generated, activated, merged, archived, expired *(state names unverified)*). Writes go through an LLM extractor; merging and conflict handling are LLM-driven with versioning. MemOS reports LoCoMo results claiming gains over mem0 and others (vendor-claimed). Of the systems here it is the one with the most explicit governance vocabulary (provenance, versions, access policies), but much of it is framework rather than measured behaviour.

### 2.7 A-MEM

A research system (Xu et al., arXiv 2502.12110, "Agentic Memory for LLM Agents") inspired by Zettelkasten:

- Each memory is a **note** with content, timestamp, LLM-generated keywords, tags and a context description, and an embedding.
- **Link generation**: on write, the nearest notes by embedding are retrieved and an LLM decides which to link to the new note.
- **Memory evolution**: the LLM may also update the context, keywords and tags of the linked older notes in light of the new one.

Retrieval is embedding similarity plus following links. No explicit conflict or temporal model: evolution rewrites old notes' metadata, which is powerful and also a write path from new (possibly untrusted) content into old notes. Evaluated on LoCoMo in the paper.

### 2.8 Others worth knowing

- **Generative Agents** (Park et al., 2023): a memory stream of observations; retrieval scores each memory by **recency** (exponential decay since last access), **importance** (an LLM-rated 1 to 10 at write time) and **relevance** (embedding similarity), summed with weights. **Reflection**: when the summed importance of recent memories passes a threshold, the agent asks itself high-level questions and writes the answers as new memories citing their sources. The origin of most "importance and decay" scoring.
- **MemoryBank** (Zhong et al., 2023): Ebbinghaus-curve forgetting: a memory's strength decays with time and is reset when recalled.
- **MemoryOS** (BAI-LAB, 2025): short, mid and long-term tiers like an OS page hierarchy; mid-term segments are promoted by a "heat" score from visits, interaction length and recency *(details unverified)*.
- **Memobase**: user-profile-centred memory: a schema of profile slots (topics and subtopics) filled and updated by an LLM from buffered chats, plus an event timeline; profiles are pinned, events searched *(unverified in detail)*.
- **Supermemory**: a hosted memory and RAG API with ingestion from many sources; claims version and relationship tracking between memories ("updates", "extends", "derives") *(unverified)*.
- **MIRIX** (2025): six typed memories (core, episodic, semantic, procedural, resource, knowledge vault) each managed by its own agent, with a meta memory manager routing writes; the knowledge vault holds sensitive items with access levels *(unverified in detail)*.
- **HippoRAG** (2024, and HippoRAG 2): retrieval over an LLM-extracted open knowledge graph with Personalized PageRank from query entities, modelled on hippocampal indexing; a retrieval method more than a write policy, strong on multi-hop QA.
- **Second-Me**: trains a personal model (parametric memory) from a user's documents; relevant only as the far end of "memory as weights".
- **ChatGPT memory, Claude memory and Claude Code auto memory, OpenClaw, Hermes Agent**: covered in the 2026-09-29 research doc. The Anthropic API also offers a client-side **memory tool** (a `/memories` directory the model reads and writes through tool calls, stored by the application) *(details per current docs, verify)*: the Letta pattern with files.

## 3. Dimension by dimension

### 3.1 Extraction and the write path

| Pattern | Who decides what is stored | When | Systems |
|---|---|---|---|
| Agent self-edit | The working agent, through memory tools | Hot path | Letta core and archival, LangMem hot path, Claude memory tool, Claude Code auto memory |
| Extractor model | A separate LLM call over recent messages | Per message or per turn, synchronous or async | mem0, Graphiti, Cognee, MemOS, A-MEM, Memobase |
| Background manager | An LLM after the conversation goes quiet, or a second agent | Debounced or scheduled | LangMem background manager, Letta sleep-time agents, ChatGPT background synthesis, OpenClaw dreaming |
| Reflection | The agent, when an importance budget is passed | Threshold-triggered | Generative Agents |

Observations:

- Almost every system lets a model decide **what** is stored. The ones that also let the model decide **whether** with no deterministic check (Letta, A-MEM, mem0) are the ones the poisoning papers attack (§4).
- Trigger is increasingly deterministic and content is model-written: OpenClaw and Hermes (counters), LangMem (debounce), Generative Agents (importance threshold). Deskmates's A1 consolidation trigger follows the same rule.
- Only a few record **provenance strong enough to recover trust**: Graphiti links edges to episodes; MemOS has provenance metadata; mem0 keeps operation history but not taint. None that the author knows of propagates a taint bit from the run's inputs the way ADR-0011 decision 3 does.

### 3.2 Deduplication

| Approach | Systems |
|---|---|
| Embedding neighbours, then an LLM decides duplicate or not | mem0 (as `NOOP` or `UPDATE`), Graphiti (entity resolution and edge dedup), LangMem, A-MEM (links rather than merges) |
| Cosine thresholds with an LLM band | CrewAI (≥ 0.98 auto, ≥ 0.85 asks a model), per the 2026-09-29 doc |
| Deterministic ids from normalised names | Cognee entities *(partly)*, Graphiti also uses exact name matches first |
| None; the agent rewrites | Letta core blocks |

The embedding-plus-LLM approach catches paraphrases ("Postgres 16" and "PostgreSQL version 16") that a lexical key misses. It also merges things it should not: an LLM shown two similar facts tends to unify them, and conditions get dropped (the "When Memory Becomes Authority" finding that consolidators keep the claim and drop its usage constraints applies here too).

### 3.3 Conflicts and supersession

| Approach | What happens to the old value | Systems |
|---|---|---|
| LLM chooses UPDATE or DELETE | Overwritten or removed; history table keeps the old text | mem0, LangMem |
| LLM detects contradiction, old edge invalidated | Kept with `invalid_at` / `expired_at`; bi-temporal | Graphiti / Zep |
| Versioned rewrite | New version, old retained | MemOS *(per design)*, Letta context repositories (git), Google Memory Bank revisions |
| Agent rewrites the block | Gone unless the platform versions blocks | Letta core memory (classic) |

Two distinctions matter for Deskmates:

- **Event time versus ingestion time.** Graphiti is the clearest about it: `valid_at` comes from the text when the text dates the fact, otherwise from the episode's reference time; arrival order does not decide. Deskmates's A9 does the same with a sidecar-stamped turn time and explicitly refuses dates written by the model as a clock (a deliberate difference: Graphiti trusts the extracted date, Deskmates does not, because a page can write any date).
- **Who resolves.** Everyone except Deskmates asks a model "do these contradict?". Deskmates's A7 decides "same fact" with a lexical key and decides the winner by recency; no model is asked and no human is asked (A6).

### 3.4 Freshness, decay and forgetting

| Mechanism | Systems |
|---|---|
| Recency-weighted retrieval score (exponential decay) | Generative Agents, CrewAI half-life, many RAG stacks |
| Strength decay reset on recall (Ebbinghaus) | MemoryBank, MemoryOS heat *(roughly)* |
| Validity intervals, no decay | Graphiti / Zep |
| TTL or expiry | Google Memory Bank, mem0 hosted *(unverified)* |
| Size limit forces compression | Letta core blocks, Claude Code `MEMORY.md` 200 lines |
| Background rewrite of time-sensitive items | ChatGPT background synthesis, OpenClaw dreaming re-reads live notes |
| Lifecycle states moved by a scheduler | MemOS |

No surveyed open-source system runs a **scheduled revalidation of every note against recent activity** the way A28 now does. The closest are background rewriters (ChatGPT, OpenClaw, Letta sleep-time), which rewrite memory wholesale rather than issuing per-note verdicts. Per-note verdicts with a human queue for the uncertain ones are, as far as the author knows, Deskmates's own design; that makes the A33 measurements (false-stale and false-confirm rates) more important, because there is no outside evidence to lean on.

Decay scoring is common; it changes ranking, not truth. A note that is old but true is down-ranked; a note that is new but false is up-ranked. Intervals and revalidation address truth; decay addresses relevance. Deskmates has the first and not the second (§5).

### 3.5 Retrieval

| Mechanism | Systems |
|---|---|
| Pinned block in the prompt | Letta core, Claude Code `MEMORY.md`, Memobase profile, ChatGPT saved memories, Deskmates pinned index (decision 9) |
| Vector search | mem0, LangMem, A-MEM, Letta archival, Cognee, MemOS |
| Keyword (BM25 / full text) | Graphiti (hybrid), Letta recall memory, Deskmates `memory_search` (FTS) |
| Graph traversal | Graphiti BFS, mem0 graph, Cognee graph completion, HippoRAG PPR |
| Fusion and reranking | Graphiti (RRF, MMR, node distance, cross-encoder), mem0 optional reranker |
| Recency / importance / relevance score | Generative Agents |
| Agent-driven search through tools | Letta, LangMem hot path, Claude memory tool, Deskmates `memory_search` |

The field converges on "small pinned index plus searched store", which ADR-0011 decision 9 already is. Where Deskmates is behind is the search itself: lexical only, no embeddings, no reranker, no graph neighbourhood. The owner's ruling 9 (2026-10-14) approved hybrid Knowledge and memory search with bge-m3 and the reranker on tos-00 as a next-batch item; §6 C2 is that change with an evaluation attached.

### 3.6 Evaluation

| Benchmark | What it tests | Caveats |
|---|---|---|
| LoCoMo | QA over long multi-session dialogues | Known wrong answer keys and a lenient LLM judge (2026-09-29 doc §4); vendors' LoCoMo numbers conflict |
| LongMemEval | Information extraction, multi-session reasoning, temporal reasoning, knowledge update, abstention | Conversational; the knowledge-update and abstention splits map to G-STALE and to "don't invent" |
| DMR (Deep Memory Retrieval, from MemGPT) | Recall of facts from earlier sessions | Easy; saturated by most systems |
| MemoryAgentBench | Accurate retrieval, test-time learning, long-range understanding, conflict resolution (FactConsolidation) | Component-level; exact-match scoring is a strength |
| MemoryArena | Multi-session interdependent tasks including web navigation | Closest public match to Deskmates's use |
| Poisoning: MINJA, AgentPoison, MemSecBench, PMPA | Injection success, cross-session persistence, repair | Port case patterns onto the golden site (G-POISON) |

Most vendor numbers are QA accuracy with an LLM judge on conversational data. None measures what Deskmates cares about most: whether a **bot acting on a site** used the current value instead of a stale one, and whether a page could change what it believes. That is why `deskbench-memory-v1` (G-RECALL, G-STALE, G-POISON and the others in the M3 plan) uses deterministic oracles on golden-site state rather than an LLM judge, and why a memory-off arm is always included. Public benchmarks stay component checks.

## 4. Security literature that bears on every dimension

Summarised in the 2026-09-29 doc; restated here because each §6 change has to be read against it:

- **Query-only injection** (MINJA, arXiv 2503.03704): an attacker with only normal user access gets malicious records into memory through crafted interactions, because the extractor stores what it is shown. Applies to every extractor-model write path (mem0, Graphiti, Cognee, MemOS, A-MEM, LangMem background).
- **Retrieval poisoning** (AgentPoison, arXiv 2407.12784): triggers optimised so that poisoned records are retrieved by embedding search. Embedding retrieval is the attack surface; a lexical store is not immune but is harder to target by optimisation.
- **Write-through-authorised-path** attacks on agent harnesses (MemGhost, PMPA, both read at abstract level): one email, PDF or image writes persistent memory in OpenClaw and the Claude Code SDK family.
- **Authority collapse** ("When Memory Becomes Authority", abstract level): consolidators keep a claim and drop its constraints; storing an authority label per memory removed unauthorised actions in their test.
- **Memory evolution** (A-MEM) and **LLM UPDATE/DELETE** (mem0) give new content a way to rewrite or delete old content. In Deskmates terms, that is untrusted text changing trusted entries, which ADR-0011 forbids except for the accepted A11 surface (a newer untrusted value closes a trusted one and stays unpinned).

Consequences for any change borrowed from the field: model output may **propose** or **rank**; it may not raise trust, merge across trust levels, or rewrite a trusted entry's body. The A28 recheck already follows this (it renews, never rewrites, and never sees `replaced_trusted` flags); every §6 item is held to the same line.

## 5. Deskmates compared

### 5.1 Side by side

| Dimension | Field's common choice | Deskmates (ADR-0011 through amendment 4) | Deliberate? |
|---|---|---|---|
| Who writes | Model extractor or the agent's own tools | The run summary proposes items with a scope; the Gateway classifies and stores them (decisions 2, 3) | Yes |
| Trust | Rarely tracked | Sidecar taint per run; untrusted items are never pinned or promoted (decisions 3, 5) | Yes: the main difference |
| Rules vs notes | Mostly mixed; procedural memory rewrites prompts (LangMem) | Rules are human-only; learned writes cannot touch SOUL, approvals, risk tiers or egress (decision 1, A5); imperatives gated (decision 4) | Yes |
| What is never learned | Usually nothing filtered | Deterministic do-not-learn filter for failures, blocks, negative claims, session state (A2) | Yes, from OpenClaw and Hermes lessons |
| Dedup | Embeddings plus LLM | Lexical fact key and value equality; copies add a source, never corroborate (A7, A10) | Yes, but weaker on paraphrase |
| Conflict | LLM UPDATE/DELETE, or LLM-detected invalidation | Same key, newer effective time wins silently; old kept closed with a receipt (A6 to A9, A12) | Yes (owner ruling 2026-10-13) |
| Time | Ingestion order (mem0) or extracted dates (Graphiti) | Sidecar turn stamp clamped to the run; model-written dates never used as a clock (A9) | Yes |
| History | History table or none; Graphiti and MemOS keep versions | Immutable versions, tombstone with redaction, undo (decision 7) | Yes |
| Scope | User / agent / session ids | Task, workspace, bot, rule; workspace is the boundary, no access control between bots (decisions 1, 10) | Yes (ADR-0004) |
| Freshness | Decay scores, TTL or intervals | Intervals plus TTL; a 1-day horizon flags every note daily; model recheck renews or sends to a human (A25 to A28) | Yes (owner ruling 2026-10-14) |
| Organisation | Model-built graph, communities, links, tags | Deterministic topic, daily model labels, model split proposals a human accepts (A20, A30 to A32) | Partly |
| Consolidation | Background LLM rewrite | Counter-triggered background bot run; applied only when all sources are trusted (decision 8, A1) | Yes |
| Retrieval | Hybrid vector, keyword, graph, rerank | Pinned index (120 + 80 lines) plus FTS `memory_search` | No: a gap |
| Ranking | Recency, importance, relevance | Index ranked by scope and recency rules; no importance score | No: a gap |
| Evaluation | LoCoMo / LongMemEval QA with LLM judge | Predeclared paired campaigns on `deskbench-memory-v1` with deterministic oracles and a memory-off arm; not run (A14, A24, A33) | Yes; not yet executed |

### 5.2 Where Deskmates is stronger by design

- **Trust is structural.** No surveyed open-source system propagates run taint into each stored item and keeps untrusted items out of the prompt. This is the defence the poisoning literature points to.
- **No model can delete or rewrite a trusted fact.** mem0's `DELETE` and A-MEM's evolution are exactly the paths MINJA-style attacks use. Deskmates's only automatic closer of a trusted fact is a same-key newer value (A11), which stays untrusted and unpinned, and is surfaced as `replaced_trusted` for a human.
- **Rules cannot be learned.** LangMem's procedural memory rewrites the system prompt from trajectories; Deskmates refuses learned writes to rules outright.
- **Time is not taken from text.** Graphiti's extracted `valid_at` is better at real-world dating but lets a document backdate or future-date a fact; Deskmates's A9 cannot be steered that way.
- **Everything is reversible and attributed.** Versions, receipts, undo, batch undo, split undo.
- **Deterministic and replayable.** The pinned version set is in `runs.config_json`; replay rebuilds it. Model-based dedup and conflict resolution are not replayable without recording the model's decisions.

### 5.3 Where Deskmates is weaker

- **The fact key is lexical.** Paraphrases with different content words get different keys (missed supersession, two current values); unrelated sentences that happen to share content words get the same key (false supersession). A7 says this is measured, not assumed away; no measurement exists yet.
- **Search is FTS only.** No embeddings, no reranker, no graph neighbourhood. Recall of a fact asked about in other words depends on the bot's choice of query terms.
- **No entity model.** "The staging database", "VendorDB staging" and "db-stg" are three strings, not one entity. Graphiti and mem0 graph resolve these; Deskmates's topic (A20, A31) is a browsing tag only.
- **No importance or access signal.** Notes that are used every day and notes nobody has read in a month are ranked alike within their scope; the pinned index can fill with the wrong 120 lines.
- **Recheck volume.** With a 1-day horizon every current workspace and bot note is flagged daily, and A28 bounds rechecks at 200 a day per workspace. A workspace with more than 200 current notes cannot be fully rechecked daily, so the open queue grows and the oldest-first rotation means each note is rechecked every *n*/200 days. The cost (cheap-model tokens) is low on a local model, but the false-confirm risk compounds: each daily `still_true` renews TTL, so a wrong note can live indefinitely on model say-so.
- **Recheck evidence is thin.** The model sees a bounded excerpt of shared threads and tasks. Most facts are not mentioned in any given week's chat, so `unclear` will likely dominate, and `still_true` may often mean "nothing contradicts it" rather than "something confirms it". The prompt should make that distinction explicit; the A33 false-confirm rate will show whether it does.
- **Not evaluated.** The field's numbers are weak, but Deskmates's are absent.

## 6. Changes worth trying after the current design has run for a while

The owner's instruction is to run the current design first. Each item below states the precondition that must be observed in production before it is worth an experiment. All are strategy changes under AGENTS.md: one knob per experiment, a paired comparison through `evals/compare.ts` per duration bucket, a memory-off arm always included, and the decision rules of `measurement-2026-09-20.md` §4.3 and the M3 plan's "Decision rules" (memory change: paired campaign success difference per bucket with the 95% interval above 0, pass^k not worse; safety gates are not trade-offs: a change that raises injection or cross-session attack success is rejected whatever its gain; poisoning claims need at least 30 trials for a rule-of-three bound under 10%).

None of these is authorised to run as a paid campaign. Memory integration preparation is authorised; the evaluations below would run on the local models of tos-00 (priced as known zero, ruling 9) or wait for an owner authorisation.

Common to every plan:

- **Arms:** baseline (current ADR-0011 behaviour at the commit under test), treatment (one knob changed), memory-off (no pinned index, no `memory_search`).
- **Task set:** `deskbench-memory-v1` campaign families (G-RECALL, G-STALE, G-POISON, G-RULE, G-SCOPE), plus the A14 recency fixtures, plus any item-specific fixtures named below. Pairing unit is the campaign; session order randomised across replicates.
- **Always-reported metrics:** G-RECALL current-value recall, G-STALE stale-use rate, G-POISON injection and cross-session attack success (with the rule-of-three bound), false and missed supersession rate, tokens (model jobs and runs separately), human-queue size per workspace per day (needs-a-human flags plus gated confirmations), and the fingerprint.

### C1. Embedding-assisted fact key

**What changes.** When a new item has no current note with its lexical key, the Gateway asks a local embedding service (bge-m3 on tos-00, via a sidecar or a connector, never a Gateway model call *(a pure embedding call is not a model run in ADR-0023 terms; that classification needs an ADR decision first)*) for the nearest current notes in the same store, and the reranker scores the pairs. Above a calibrated threshold, the pair is a **candidate same-fact**. The candidate is then checked deterministically: same store, same trust, no condition-number conflict (A7's condition rule), and the value or polarity differs. Only then is it treated as same-key for A8 and A9.

**Benefit.** Fewer missed supersessions on paraphrases; fewer two-current-values cases.

**Risk.** False supersession rises (similar is not same), and embedding neighbourhoods are an AgentPoison-style target: a page could craft text whose embedding lands next to a trusted fact to close it. Mitigation: candidate same-fact may only close a note of **equal or lower** trust; an untrusted candidate never closes a trusted note through this path.

**Knob.** `memorySameFact = lexical | lexical+embedding@<threshold>`.

**Evaluation.** Fixtures: the A14 recency set extended with paraphrase pairs (same fact, different words), near-miss pairs (same words, different fact, different conditions) and adversarial paraphrases from a page. Primary metric: missed-supersession rate on paraphrases must fall with its interval below 0; false-supersession rate non-inferior within 2 points; G-STALE non-inferior; G-POISON not higher (any increase rejects). Report the human-queue size.

**Precondition.** Production shows missed supersessions: two current notes in one store that a reviewer would call the same fact. Count them from the Learned memory page or a query over current notes with high FTS overlap, over at least two weeks of traffic in three or more workspaces.

### C2. Hybrid `memory_search` with a reranker

**What changes.** `memory_search` combines FTS with bge-m3 vector search over current notes, fuses with reciprocal rank fusion, and reranks the top 50 with the tos-00 reranker. Trust wrapping, current-only filtering, paging (A23) and the recorded supplied versions (A13) are unchanged. Owner ruling 9 already approved hybrid Knowledge and memory search; this item is the measurement that should accompany it.

**Benefit.** Higher recall when the bot's query words differ from the note's words.

**Risk.** Retrieval poisoning by embedding proximity (AgentPoison); more untrusted notes surfaced (still wrapped). Latency on the run's hot path.

**Knob.** `memorySearch = fts | hybrid+rerank`.

**Evaluation.** G-RECALL with a paraphrase variant (the session that needs the fact phrases the need differently from how it was learned), G-POISON with poisoned notes crafted to rank for common queries. Primary: G-RECALL difference with interval above 0 in at least one bucket and no bucket worse; G-POISON not higher; p95 tool latency and tokens reported. Component check offline: MemoryAgentBench accurate-retrieval split and LongMemEval_S knowledge-update split on the store alone (component evidence only).

**Precondition.** Run logs show `memory_search` calls with zero or irrelevant hits followed by rediscovery of a fact that was in memory (the A13 supplied-versions record plus the trajectory make this countable).

### C3. Model-proposed supersession, deterministically checked

**What changes.** The daily organisation job (A30) also returns pairs it believes state the same fact with different values. Each pair passes the same deterministic checks as C1 and becomes a **supersession proposal** shown with the split proposals; an Admin accepts, or (if the owner later decides) proposals between notes of equal trust are applied automatically with an undo.

**Benefit.** Catches same-fact pairs the lexical key misses, without putting a model in the write path.

**Risk.** Model error closes a true fact (mitigated by human accept and undo); queue growth.

**Knob.** `memoryOrganizeSupersession = off | propose`.

**Evaluation.** Offline on production snapshots first (no run needed): proposals kept, accepted and later undone rates. Then a paired campaign on G-STALE with paraphrased updates. Primary: stale-use rate falls, human actions per resolved pair reported, G-POISON not higher.

**Precondition.** C1's precondition, and A31/A32 kept and accepted rates showing the organise job is useful at all (labels kept rate and split accept rate over a month).

### C4. Ranked pinned index: recency, use and importance

**What changes.** Within each scope's line budget, notes are ordered by a score combining recency of effective time or confirmation, **use** (how often the note was supplied to runs through `memory_search` or pinned and the run then cited or acted on it, from A13 records) and a deterministic importance proxy (number of independent sources, A10; human confirmation). No LLM-rated importance in the first experiment, so the score stays deterministic and replayable.

**Benefit.** The 200 pinned lines hold what bots actually use; fewer `memory_index` exclusions of useful notes.

**Risk.** A rich-get-richer loop pins notes because they were pinned; sources counted as evidence contradicts A10 ("copies are not corroboration") unless only independent runs count. Untrusted notes stay excluded regardless of score.

**Knob.** `memoryIndexOrder = current | scored-v1`.

**Evaluation.** G-RECALL and G-LONG with budget pressure (more notes than the budget), G-STALE (a scored index must not keep a superseded value; it cannot, since only current notes are candidates, but the test confirms it). Primary: campaign success interval above 0 under budget pressure; cache hit ratio and index tokens reported; fingerprint moves are expected and read.

**Precondition.** `memory_index` events show budget exclusions in real workspaces (A4 counts); without exclusions, ordering changes nothing.

### C5. Adaptive revalidation horizon

**What changes.** Instead of a flat 1-day horizon, each note's next revalidation time grows after each `still_true` (human or model) and resets after a correction, like spaced repetition (MemoryBank's strength reset, without decay of retrieval): 1, 2, 4, 8 days, capped at the old 90/180, and reset to 1 day when the note's key is superseded or a human edits it. TTL rules unchanged.

**Benefit.** The recheck budget (200 a day) goes to notes that change or are new; the queue stops growing in large workspaces; fewer model confirmations means fewer chances of a false confirm.

**Risk.** A note that becomes false during a long interval is rechecked later. A false model confirm also stretches the interval; so the interval should grow only on human confirmations, or on model confirmations that cite evidence (C6).

**Knob.** `memoryHorizon = flat-1d | adaptive-v1`.

**Evaluation.** G-STALE with seed mutations at varied delays after learning, run over simulated days (fake clock; the recheck job uses the local model). Primary: stale-use rate non-inferior (interval upper bound below +3 points); recheck tokens and human-queue size must fall by at least 15% (the cost-type δ). Also report the A33 false-stale and false-confirm rates for both arms.

**Precondition.** A33 metrics from production: daily-limit exhaustion observed (queue growing faster than 200 a day) or recheck verdicts dominated by `unclear` and `still_true` on notes that never change. At least a month of A28 traffic.

### C6. Evidence-cited recheck verdicts

**What changes.** A28's `still_true` must cite at least one message or task id from the supplied excerpt that states or uses the fact; a `still_true` without a valid citation is downgraded to `unclear`. The Gateway checks that the cited id was in the input. `possibly_stale` must cite the contradicting item likewise.

**Benefit.** Separates "confirmed by evidence" from "nothing contradicts it", directly targeting the false-confirm risk noted in §5.3.

**Risk.** More `unclear`, so notes age out of TTL more often (they stay in the index unless TTL expires); evidence from bot messages may itself be page-derived. The cited message's taint could be carried: a citation to a message from a tainted run renews only untrusted notes.

**Knob.** `memoryRecheckEvidence = optional | required`.

**Evaluation.** Offline first: replay recorded recheck job inputs (the run config holds the input triples; transcripts are in the database) through both prompt variants on the local model, grade verdicts against human labels on a sample of 200. Then G-STALE. Primary: false-confirm rate falls with interval below 0; stale-use non-inferior; human-queue size reported.

**Precondition.** A33 false-confirm rate measured above a few percent, or a human-labelled sample showing `still_true` given without evidence.

### C7. Annotate or withhold `possibly_stale` notes in the pinned index

**What changes.** A note whose open flag carries a model `possibly_stale` verdict is rendered in the pinned index with an "(unconfirmed since …, possibly stale)" marker (variant a) or left out of the index but still searchable (variant b). A27 names this as a strategy change not to be made without evaluation.

**Benefit.** Fewer actions taken on stale facts while waiting for a human.

**Risk.** A false `possibly_stale` hides a true fact; a page could provoke `possibly_stale` verdicts on trusted facts through bot messages in shared threads (a denial-of-memory attack). Variant a is milder.

**Knob.** `memoryIndexStale = ignore | annotate | withhold` (one variant per experiment).

**Evaluation.** G-STALE (true stale), G-RECALL (false stale: facts flagged but true), G-POISON with a page that tries to make a trusted fact look stale. Primary: stale-use falls with interval below 0, G-RECALL non-inferior, the denial-of-memory fixture's success reported with its rule-of-three bound.

**Precondition.** A28 has run long enough to measure its false-stale rate (human answers `still_true` on model `possibly_stale` flags), at least 100 decided flags.

### C8. Graphiti-style entities and edges for workspace facts

**What changes.** The daily organisation job extracts entities (systems, sites, databases, people's roles) and relations from current workspace notes; entities are resolved by name plus embedding plus model, deterministically checked (the entity name must appear in the note body). Edges point at the notes they came from and inherit their trust and interval; they are never a separate source of truth. `memory_search` can expand a hit to notes about the same entity.

**Benefit.** "db-stg", "staging database" and "VendorDB staging" become one entity; multi-hop questions ("which bot last changed the staging schema and what was the limit it found") become answerable.

**Risk.** The largest change in this list: a second index to keep consistent with supersession, forget and undo; model-built structure is a poisoning surface (an attacker's entity merge). Edges must close when their source note closes.

**Knob.** `memoryGraph = off | entities-v1` (retrieval expansion only; nothing pinned changes in the first experiment).

**Evaluation.** A new multi-hop family in `deskbench-memory-v1` (facts learned in separate sessions by different bots, combined in a later task), plus G-POISON with entity-collision pages. Primary: multi-hop campaign success interval above 0, G-RECALL and G-POISON non-inferior, tokens reported.

**Precondition.** C2 measured first (hybrid search may close most of the gap at much lower complexity); production evidence of entity aliasing in topics (several model labels naming one system).

### C9. Sleep-time episode consolidation

**What changes.** Consolidation (decision 8, A1) additionally runs a "sleep-time" pass over recent episodes of a workspace, not only per bot: it proposes workspace observations that several episodes support, citing them, written through the normal learned path (decisions 3 and 4, amendment 2), so trust is the minimum of the sources.

**Benefit.** Workspace facts that no single run stated explicitly but several runs relied on; closer to Letta sleep-time and OpenClaw dreaming.

**Risk.** Consolidators drop constraints (authority collapse); more items arriving means more gating. Untrusted sources yield untrusted or gated output, as today.

**Knob.** `memoryConsolidationScope = bot | bot+workspace`.

**Evaluation.** G-RECALL and G-SCOPE across bots, G-RULE (a consolidated item must not become a rule), G-POISON with poisoned episodes. Primary: shared recall interval above 0, rule-override exactly 0, G-POISON not higher; consolidation tokens reported.

**Precondition.** A1 consolidation runs observed in production, with their outputs reviewed; episode volume large enough that unconsolidated episodes accumulate.

### C10. A component harness for the memory store

**What changes.** Not a behaviour change: an offline harness that drives the Gateway memory module (learned write, supersession, search, freshness, recheck verdict application) with fixtures adapted from LongMemEval knowledge-update and abstention questions and MemoryAgentBench FactConsolidation, mapped to workspace facts, using exact-match oracles. It runs at zero model tokens except for the recheck and organise jobs, which use the local model.

**Benefit.** Every item above gets a cheap first screen before any campaign; regressions in the deterministic core (fact key, ordering) are caught by T0/T1-style runs.

**Risk.** Component scores are not evidence that an agent improved (M3 plan: "component metrics only"). Must be reported as such.

**Knob.** None; it is measurement infrastructure.

**Evaluation of the harness itself.** Its fixtures must reproduce known behaviour: the A7 table cases, the A14 recency fixtures, and at least one known missed paraphrase supersession (so C1 has something to fix).

**Precondition.** None; it can be prepared now under the memory-integration-preparation authorisation. It is the one item in this list that does not need production traffic first.

### 6.1 Suggested order

1. C10 (harness, now).
2. Observe A28 and A33 metrics for at least a month: false-stale, false-confirm, `unclear` share, queue growth, daily-limit exhaustion.
3. C6 (evidence-cited verdicts) if false-confirm is visible; C5 (adaptive horizon) if the queue grows.
4. C2 (hybrid search), measured as it lands under ruling 9.
5. C1 and C3 (same-fact resolution) once missed supersessions are counted.
6. C4 and C7 (index ranking and stale annotation), each needing the earlier measurements.
7. C9, then C8, only if the simpler changes leave a measured gap.

## 7. Open questions for the owner

- Whether a pure embedding or reranker call (C1, C2) counts as a "model call" the Gateway must not make. Today's rule (the Gateway never calls a model) suggests it runs in the sidecar or behind a connector; an ADR should say which before C1 or C2 is built.
- Whether supersession proposals between equal-trust notes (C3) may ever apply automatically, given the owner's preference for less human intervention.
- Whether the A28 recheck should be allowed to renew TTL on untrusted notes at all, or only on trusted ones (it currently may; trust is unchanged, so untrusted notes stay unpinned either way).

## References

Verify each against the current upstream version before relying on it.

- mem0: Chhikara et al., "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory", arXiv 2504.19413; github.com/mem0ai/mem0.
- MemGPT: Packer et al., "MemGPT: Towards LLMs as Operating Systems", arXiv 2310.08560; Letta docs (core, archival and recall memory; sleep-time agents); github.com/letta-ai/letta.
- Zep / Graphiti: Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory", arXiv 2501.13956; github.com/getzep/graphiti.
- LangMem: LangChain LangMem docs (memory types, hot path and background managers, prompt optimisation); github.com/langchain-ai/langmem.
- Cognee: github.com/topoteretes/cognee and its docs (add, cognify, search, memify).
- MemOS: Li et al., "MemOS: A Memory OS for AI System", arXiv 2505.22101 and the extended 2507 version; github.com/MemTensor/MemOS.
- A-MEM: Xu et al., "A-MEM: Agentic Memory for LLM Agents", arXiv 2502.12110.
- Generative Agents: Park et al., "Generative Agents: Interactive Simulacra of Human Behavior", UIST 2023, arXiv 2304.03442.
- MemoryBank: Zhong et al., arXiv 2305.10250.
- MemoryOS: BAI-LAB, "Memory OS of AI Agent", arXiv 2506.06326 *(id unverified)*.
- MIRIX: arXiv 2507.07957 *(id unverified)*.
- HippoRAG: Gutiérrez et al., NeurIPS 2024, arXiv 2405.14831; HippoRAG 2, arXiv 2502.14802 *(id unverified)*.
- LongMemEval: Wu et al., ICLR 2025, arXiv 2410.10813. LoCoMo: Maharana et al., arXiv 2402.17753. MemoryAgentBench: arXiv 2507.05257 *(id unverified)*.
- Poisoning: MINJA, arXiv 2503.03704; AgentPoison, arXiv 2407.12784; MemGhost, PMPA, MemSecBench and "When Memory Becomes Authority" as cited (abstract level) in `m3-context-memory-research-2026-09-29.md`.
- Deskmates: `docs/adr/0011-learned-memory-scopes.md` (through amendment 4); `docs/design/m3-context-and-memory-plan-2026-09-29.md`; `docs/design/m3-context-memory-research-2026-09-29.md`; `docs/design/measurement-2026-09-20.md`.

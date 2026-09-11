---
title: Codebase search and indexing
description: Choose exact or semantic search, configure the local index, and understand model downloads and derived storage.
section: tools
order: 7
type: guide
audience: Large-repository users
related:
  - troubleshooting/indexing-dictation
  - tools/memory
  - reference/storage
---

Agent V has exact search tools and two local derived indexes. They are separate from memory.

## Choose a search path

- glob finds workspace-relative paths by pattern.
- grep finds regular-expression matches with lines.
- search finds filename or content substrings.
- Sparsegrep maintains a trigram/path index for fast exact discovery.
- `codebase_search` runs semantic search over the code index.

Prefer exact search when you know a symbol, label, filename, or error. Use semantic search when the concept matters more than its spelling.

## Configure semantic indexing

Open Settings → Indexing:

- Enable codebase index: default on.
- Embedder: LightOn dense ONNX (default), LFM2.5-Embedding-350M, Ollama, or **Local** hash.
- Auto-download model: default on for the local dense model.
- Ollama embedding model: default nomic-embed-text.
- Index status
- Reindex workspace

When indexing is disabled, `codebase_search` is removed from the run tool catalog.

## Index lifecycle

Index status reports phases such as downloading, loading, indexing, hash fallback, ready, and error. Live progress includes scanned files, embedded chunks, skipped files, removals, and current path.

The semantic and sparse indexes are derived caches under the app-data workspace record, not inside the project tree. Reindexing can rebuild them without changing source files.

## Privacy and resource use

The local dense and hash paths process data on this machine. The Ollama embedder sends text to the configured Ollama host, which can be remote. Model weights and indexes consume disk; dense embedding consumes CPU and memory during build.

If download, Ollama, or reindex state fails, preserve the status message and selected embedder, then follow Indexing and dictation issues.

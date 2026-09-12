---
title: Codebase search and indexing
description: Choose exact or keyword search, configure the local index, and understand derived storage.
section: tools
order: 7
type: guide
audience: Large-repository users
related:
  - troubleshooting/indexing-dictation
  - tools/memory
  - reference/storage
---

Agent V has exact search tools and one local derived index. The index is separate from memory.

## Choose a search path

- glob finds workspace-relative paths by pattern.
- grep finds regular-expression matches with lines.
- search finds filename or content substrings.
- `codebase_search` runs ranked keyword search over the code index — identifiers, file names, and substrings, ranked with BM25.

Prefer exact search when you know a symbol, label, filename, or error. Use `codebase_search` when you want the most relevant files for a keyword or identifier without knowing the exact spelling.

## Configure the code index

Open Settings → Indexing:

- Enable codebase index: default on.
- Index status
- Reindex workspace

When indexing is disabled, `codebase_search` is removed from the run tool catalog.

## Index lifecycle

Index status reports phases such as syncing, ready, idle, and error. Live progress includes scanned files, updated files, unchanged files, removals, and the current path.

The index is a derived SQLite cache under the app-data workspace record, not inside the project tree. Reindexing can rebuild it without changing source files. It stores production source only — tests, docs, configs, and lockfiles stay out, and grep/glob still find those with a live scan.

## Privacy and resource use

Indexing runs entirely on this machine. No models are downloaded, no embeddings are computed, and no network requests are made for the index. The SQLite database consumes a small amount of disk; building it is a fast local scan.

If reindex or sync state fails, preserve the status message, then follow Indexing and dictation issues.

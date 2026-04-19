#!/usr/bin/env node
/**
 * Auto-Memory Extraction — Inspired by Claude Code's Session Memory system
 * 
 * Scans recent daily notes for new decisions, learnings, errors, and facts.
 * Extracts them into the appropriate reference files if not already captured.
 * 
 * Usage: node scripts/auto-memory-extract.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(__dirname, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const REFS_DIR = path.join(MEMORY_DIR, 'references');
const DRY_RUN = process.argv.includes('--dry-run');

// File size limits (lines)
const LIMITS = { references: 60, learnings: 60, errors: 60 };

// Category patterns — keyword → target file
const CATEGORIES = [
  { file: 'infrastructure.md', keywords: ['unraid', 'docker', 'ssh', 'nginx', 'npm', 'port', 'firewall', 'iptables', 'cloudflare', 'dns', 'backup', 'server', 'container', 'tailscale', 'vpn', 'forgejo', 'proxy'] },
  { file: 'juda.md', keywords: ['juda', 'task', 'section', 'postgresql', 'judadb', 'vibe reflection', 'overdue', 'staging'] },
  { file: 'glow-leds.md', keywords: ['glow', 'glowleds', 'glow-leds', 'heroku', 'sentry', 'gsc', 'customer', 'email triage', 'squarespace'] },
  { file: 'openclaw-state.md', keywords: ['openclaw', 'cron', 'heartbeat', 'self-healing', 'compaction', 'memory consolidation', 'gateway', 'session', 'model', 'subagent'] },
  { file: 'people.md', keywords: ['kurt', 'destanye', 'wife', 'discord user', 'github user'] },
  { file: 'hardware.md', keywords: ['mac', 'macbook', 'windows', 'htpc', 'pi', 'raspberry', 'cpu', 'ram', 'gpu'] },
  { file: 'active-tasks.md', keywords: ['todo', 'blocked', 'waiting', 'next step', 'in progress', 'pending'] },
];

// Extraction patterns — lines containing these signal extractable knowledge
const EXTRACT_SIGNALS = [
  /\b(decided|decision|chose|choosing)\b/i,
  /\b(fixed|fix|resolved|resolution)\b/i,
  /\b(learned|lesson|insight|realized|turns out)\b/i,
  /\b(created|built|deployed|installed|configured|set up|added)\b/i,
  /\b(error|failed|broken|bug|issue|crash)\b/i,
  /\b(todo|blocked|waiting on|needs|pending)\b/i,
  /\b(updated|changed|modified|migrated|moved|renamed)\b/i,
];

function today() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function readSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function lineCount(content) {
  return content.split('\n').filter(l => l.trim()).length;
}

function extractActionableLines(content) {
  const lines = content.split('\n');
  const results = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headers, empty lines, metadata
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('```')) continue;
    // Must start with - or * (bullet point) to be a fact
    if (!trimmed.startsWith('-') && !trimmed.startsWith('*') && !trimmed.startsWith('✅') && !trimmed.startsWith('❌')) continue;
    
    // Check if line matches any extraction signal
    if (EXTRACT_SIGNALS.some(pat => pat.test(trimmed))) {
      results.push(trimmed);
    }
  }
  return results;
}

function categorize(line) {
  const lower = line.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some(kw => lower.includes(kw))) {
      return cat.file;
    }
  }
  return null;
}

function isAlreadyCaptured(line, existingContent) {
  // Normalize for comparison
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
  const lineNorm = normalize(line);
  const existingLines = existingContent.split('\n').map(normalize);
  
  // Check if any existing line is >60% similar
  for (const existing of existingLines) {
    if (!existing) continue;
    // Simple overlap check — count shared chars
    const shorter = Math.min(lineNorm.length, existing.length);
    if (shorter < 10) continue;
    let matches = 0;
    for (let i = 0; i < shorter; i++) {
      if (lineNorm[i] === existing[i]) matches++;
    }
    if (matches / shorter > 0.6) return true;
  }
  return false;
}

function isLearningOrError(line) {
  const lower = line.toLowerCase();
  if (/\b(error|failed|broken|bug|crash|issue)\b/.test(lower)) return 'error';
  if (/\b(learned|lesson|insight|realized|turns out|key|important|never|always|critical)\b/.test(lower)) return 'learning';
  return null;
}

function main() {
  console.log(`🧠 Auto-Memory Extraction ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('─'.repeat(50));
  
  // Read daily notes
  const todayNote = readSafe(path.join(MEMORY_DIR, `${today()}.md`));
  const yesterdayNote = readSafe(path.join(MEMORY_DIR, `${yesterday()}.md`));
  
  if (!todayNote && !yesterdayNote) {
    console.log('No daily notes found for today or yesterday. Nothing to extract.');
    process.exit(0);
  }
  
  // Extract actionable lines
  const todayLines = extractActionableLines(todayNote);
  const yesterdayLines = extractActionableLines(yesterdayNote);
  const allLines = [...new Set([...todayLines, ...yesterdayLines])];
  
  console.log(`Found ${allLines.length} candidate lines (${todayLines.length} today, ${yesterdayLines.length} yesterday)`);
  
  // Read all existing reference content
  const refContents = {};
  for (const cat of CATEGORIES) {
    refContents[cat.file] = readSafe(path.join(REFS_DIR, cat.file));
  }
  const learningsContent = readSafe(path.join(MEMORY_DIR, 'learnings.md'));
  const errorsContent = readSafe(path.join(MEMORY_DIR, 'errors.md'));
  
  // Categorize and deduplicate
  const additions = {}; // file → [lines]
  let skipped = 0;
  let uncategorized = 0;
  
  for (const line of allLines) {
    const category = categorize(line);
    const learnErr = isLearningOrError(line);
    
    // Add to reference file if categorized
    if (category) {
      const existing = refContents[category];
      if (!isAlreadyCaptured(line, existing)) {
        if (!additions[category]) additions[category] = [];
        additions[category].push(line);
      } else {
        skipped++;
      }
    } else {
      uncategorized++;
    }
    
    // Additionally add to learnings/errors if applicable
    if (learnErr === 'learning' && !isAlreadyCaptured(line, learningsContent)) {
      if (!additions['learnings.md']) additions['learnings.md'] = [];
      additions['learnings.md'].push(line);
    }
    if (learnErr === 'error' && !isAlreadyCaptured(line, errorsContent)) {
      if (!additions['errors.md']) additions['errors.md'] = [];
      additions['errors.md'].push(line);
    }
  }
  
  // Report and write
  const totalNew = Object.values(additions).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`\n📊 Results: ${totalNew} new items to extract, ${skipped} duplicates skipped, ${uncategorized} uncategorized`);
  
  if (totalNew === 0) {
    console.log('✅ Nothing new to extract — all knowledge already captured.');
    process.exit(0);
  }
  
  for (const [file, lines] of Object.entries(additions)) {
    const isRef = CATEGORIES.some(c => c.file === file);
    const targetPath = isRef ? path.join(REFS_DIR, file) : path.join(MEMORY_DIR, file);
    const limit = isRef ? LIMITS.references : (file === 'learnings.md' ? LIMITS.learnings : LIMITS.errors);
    
    // Check size limit
    const existing = readSafe(targetPath);
    const currentLines = lineCount(existing);
    const canAdd = Math.max(0, limit - currentLines);
    const toAdd = lines.slice(0, canAdd);
    
    if (toAdd.length === 0) {
      console.log(`  ⚠️  ${file}: at limit (${currentLines}/${limit} lines), skipping ${lines.length} items`);
      continue;
    }
    
    console.log(`  📝 ${file}: +${toAdd.length} items${toAdd.length < lines.length ? ` (${lines.length - toAdd.length} dropped — at limit)` : ''}`);
    for (const l of toAdd) {
      console.log(`     ${l.slice(0, 80)}${l.length > 80 ? '...' : ''}`);
    }
    
    if (!DRY_RUN) {
      const newContent = existing.trimEnd() + '\n\n## Auto-Extracted (' + today() + ')\n' + toAdd.join('\n') + '\n';
      fs.writeFileSync(targetPath, newContent);
    }
  }
  
  console.log(`\n${DRY_RUN ? '🔍 Dry run complete — no files modified.' : '✅ Extraction complete.'}`);
}

try {
  main();
} catch (err) {
  console.error('❌ Auto-memory extraction failed:', err.message);
  process.exit(1);
}

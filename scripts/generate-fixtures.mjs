#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_OUT = path.resolve("tests/fixtures/.generated");
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writeCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function generateF0(baseDir) {
  const dir = path.join(baseDir, "F0");
  writeCleanDir(dir);
  return { name: "F0", notes: 0, edges: 0, brokenLinks: 0, dir };
}

function generateF100(baseDir) {
  const dir = path.join(baseDir, "F100");
  writeCleanDir(dir);
  const rng = mulberry32(20260100);
  const folders = ["Projects/Alpha", "Projects/Beta", "Journal", "Reference"];

  for (let i = 0; i < 100; i++) {
    const folder = folders[i % folders.length];
    const noteDir = path.join(dir, folder);
    fs.mkdirSync(noteDir, { recursive: true });
    const title = `Fixture Note ${String(i).padStart(3, "0")}`;
    const targetIdx = Math.floor(rng() * 100);
    const targetTitle = `Fixture Note ${String(targetIdx).padStart(3, "0")}`;
    const useCrlf = i % 3 === 0;
    const useBom = i % 10 === 0;
    const eol = useCrlf ? "\r\n" : "\n";
    const lines = [
      "---",
      `title: ${title}`,
      `tags: [fixture, group-${i % 5}]`,
      `custom_unknown_key: keep-me-${i}`,
      "---",
      `# ${title}`,
      "",
      `Deterministic body for ${title} (#inline-${i % 4}).`,
      `Related: [[${targetTitle}]]`,
    ];
    let content = lines.join(eol) + eol;
    if (useBom) {
      content = "\uFEFF" + content;
    }
    fs.writeFileSync(path.join(noteDir, `${title}.md`), content, "utf8");
  }
  return { name: "F100", notes: 100, edges: 100, brokenLinks: 0, dir };
}

function generateF1000(baseDir) {
  const dir = path.join(baseDir, "F1000");
  writeCleanDir(dir);
  const rng = mulberry32(20261000);
  const folders = [
    "Projects/Core",
    "Projects/Graph",
    "Projects/MCP",
    "Architecture",
    "Lessons",
  ];

  // 1,000 notes and 2,500 explicit resolved edges (plus 50 deterministic broken links)
  let edgeCount = 0;
  let brokenCount = 0;
  for (let i = 0; i < 1000; i++) {
    const folder = folders[i % folders.length];
    const noteDir = path.join(dir, folder);
    fs.mkdirSync(noteDir, { recursive: true });
    const slug = `Note-${String(i).padStart(4, "0")}`;
    const links = [];
    const perNote = i < 500 ? 3 : 2; // 500*3 + 500*2 = 2500 resolved edges
    for (let e = 0; e < perNote; e++) {
      let target = Math.floor(rng() * 1000);
      if (target === i) target = (i + 1) % 1000;
      links.push(`[[Note-${String(target).padStart(4, "0")}]]`);
      edgeCount++;
    }
    if (i % 20 === 0) {
      links.push(`[[Missing-Target-${i}]]`);
      brokenCount++;
    }

    const content = [
      "---",
      `title: ${slug}`,
      `tags: [scale, cluster-${i % folders.length}]`,
      "---",
      `# ${slug}`,
      "",
      `Synthetic knowledge entry ${i} for benchmark and graph profiling.`,
      "",
      `Links: ${links.join(" ")}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(noteDir, `${slug}.md`), content, "utf8");
  }
  return {
    name: "F1000",
    notes: 1000,
    edges: edgeCount,
    brokenLinks: brokenCount,
    dir,
  };
}

fs.mkdirSync(outDir, { recursive: true });
const summary = [generateF0(outDir), generateF100(outDir), generateF1000(outDir)];
console.log(JSON.stringify({ seed_version: 1, outDir, fixtures: summary }, null, 2));

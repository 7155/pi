#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const courseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}

function validateManifest() {
  const path = join(courseRoot, "course-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const groups = ["layers", "lessons", "evolution", "deepDives", "labs", "project"];

  for (const group of groups) {
    for (const item of manifest[group] ?? []) {
      const relative = item.path ?? item.entry;
      if (relative && !existsSync(join(courseRoot, relative))) {
        errors.push(`manifest ${group} references missing path: ${relative}`);
      }
    }
  }

  const expected = {
    lessons: 14,
    evolution: 6,
    deepDives: 9,
    labs: 6,
    project: 7,
  };
  for (const [group, count] of Object.entries(expected)) {
    if ((manifest[group] ?? []).length !== count) {
      errors.push(`manifest ${group} expected ${count}, received ${(manifest[group] ?? []).length}`);
    }
  }
}

function validateMarkdown(path) {
  const text = readFileSync(path, "utf8");
  const relativePath = path.slice(courseRoot.length + 1);

  if ((text.match(/```/g) ?? []).length % 2 !== 0) {
    errors.push(`unbalanced Markdown fence: ${relativePath}`);
  }
  if (text.includes("小林练习题")) {
    errors.push(`obsolete practice heading: ${relativePath}`);
  }

  const links = text.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const raw = match[1].trim();
    const target = raw.split("#", 1)[0].split("?", 1)[0];
    if (!target || target.includes("://") || target.startsWith("mailto:")) continue;
    const resolved = resolve(dirname(path), target);
    if (!existsSync(resolved)) {
      errors.push(`broken relative link: ${relativePath} -> ${target}`);
    }
  }
}

validateManifest();
const markdownFiles = walk(courseRoot).filter((path) => extname(path) === ".md");
for (const path of markdownFiles) validateMarkdown(path);

let lines = 0;
let mermaidBlocks = 0;
let codeBlocks = 0;
for (const path of markdownFiles) {
  const text = readFileSync(path, "utf8");
  lines += text.split(/\r?\n/u).length;
  mermaidBlocks += (text.match(/```mermaid/g) ?? []).length;
  codeBlocks += (text.match(/```(?:ts|typescript|js|javascript|sql|bash|json|text|markdown)/g) ?? []).length;
}

const summary = {
  markdownFiles: markdownFiles.length,
  lines,
  mermaidBlocks,
  codeBlocks,
  errors: errors.length,
};
console.log(JSON.stringify(summary, null, 2));

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

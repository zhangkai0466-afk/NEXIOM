/** Reimport the upstream, credential-free visualization bundle. Adapters stay separate. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || 'D:/25数模国赛/AI可视化设计MCP');
const upstream = path.dirname(source);
const destination = path.join(repo, 'packages/visualization-engine');
const files = [];
const excluded = new Set(['__pycache__', '.pytest_cache', '.venv', '.git', 'node_modules']);
async function copyTree(from, to, label) {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name.endsWith('.egg-info') || entry.isSymbolicLink() || entry.name === '.env' || /\.(pyc|log)$/i.test(entry.name)) continue;
    const src = path.join(from, entry.name), dst = path.join(to, entry.name === 'visual_design_mcp' ? 'nexiom_visualization' : entry.name);
    if (entry.isDirectory()) await copyTree(src, dst, label);
    else if (entry.isFile()) {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      let bytes = await fs.readFile(src);
      if (label === 'visual-design-mcp' && entry.name.endsWith('.py')) bytes = Buffer.from(adaptSource(entry.name, bytes.toString('utf8')));
      await fs.writeFile(dst, bytes);
      files.push({ path: path.relative(destination, dst).replaceAll('\\', '/'), source: label, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
function adaptSource(name, content) {
  content = content.replaceAll('visual_design_mcp', 'nexiom_visualization').replaceAll('PaperSpec 已核验事实', '项目已核验事实').replaceAll('绑定赛题任务图与 PaperSpec', '绑定当前项目任务与已核验事实').replaceAll('可视化审美研究/studio/data/palettes.json', 'studio/data/palettes.json');
  if (name === 'model_client.py') return '"""NEXIOM Responses transport; no external meeting framework dependency."""\nfrom adapter import ResponsesModelClient as ModelClient\n';
  if (name === 'config.py') {
    const prefix = content.slice(0, content.indexOf('def _read_env('));
    const validate = content.slice(content.indexOf('def validate_visual_design_roster('), content.indexOf('def load_settings('));
    return prefix + validate + 'def load_settings() -> Settings:\n    from adapter import load_settings as nexiom_load\n    return nexiom_load()\n';
  }
  if (name === 'server.py') content = content.replace('from paperspec_core.transport_protocol import transport_protocol_descriptor', 'from adapter import transport_protocol_descriptor').replace('"configuration_center_is_authoritative": True', '"configuration_center_is_authoritative": False,\n        "configuration_source": "NEXIOM visualization provider"').replace(/try:\r?\n    from mcp\.server\.fastmcp import FastMCP[\s\S]*?from exc\r?\n/, 'from native_registry import NativeRegistry\n').replace('mcp = FastMCP(', 'registry = NativeRegistry(').replaceAll('@mcp.tool()', '@registry.tool()').replace('    mcp.run()', '    raise RuntimeError("Use the NEXIOM native.py worker.")');
  return content;
}
async function copyFile(from, relative, label) {
  const bytes = await fs.readFile(from), dst = path.join(destination, relative);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.writeFile(dst, bytes);
  files.push({ path: relative, source: label, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
for (const directory of ['src', 'contracts', 'templates', 'corpus', 'docs']) await copyTree(path.join(source, directory), path.join(destination, 'engine', directory), 'visual-design-mcp');
await copyFile(path.join(source, 'README.md'), 'engine/UPSTREAM_README.md', 'visual-design-mcp');
await copyFile(path.join(source, 'pyproject.toml'), 'engine/pyproject.toml', 'visual-design-mcp');
const projectFile = path.join(destination, 'engine/pyproject.toml');
await fs.writeFile(projectFile, (await fs.readFile(projectFile, 'utf8')).replace(/^.*"paperspec-core[^\n]*\n/m, '').replace(/^.*"mcp>=[^\n]*\n/m, '').replace(/^visual-design-mcp = [^\n]*\n/m, '').replace('[project.scripts]\n', '').replace('name = "visual-design-mcp"', 'name = "nexiom-visualization"').replace('readme = "README.md"','readme = "UPSTREAM_README.md"').replace('Evidence-bound visual design MCP for mathematical-modeling papers.', 'NEXIOM native evidence-bound scientific visualization engine.'));
const projectRecord = files.find(file => file.path === 'engine/pyproject.toml');
const projectBytes = await fs.readFile(projectFile);
Object.assign(projectRecord, { bytes: projectBytes.length, sha256: crypto.createHash('sha256').update(projectBytes).digest('hex') });
const studio = path.join(upstream, '可视化审美研究/studio');
for (const directory of ['src', 'data']) await copyTree(path.join(studio, directory), path.join(destination, 'studio', directory), 'scientific-palette-studio');
await copyFile(path.join(studio, 'pyproject.toml'), 'studio/pyproject.toml', 'scientific-palette-studio');
await copyTree(path.join(studio, 'generated/previews'), path.join(destination, 'previews'), 'scientific-palette-studio/previews');
const inventory = JSON.parse(await fs.readFile(path.join(source, 'corpus/research_plot_reference_inventory.json'), 'utf8'));
for (const entry of inventory.entries) await copyFile(path.join(inventory.source.directory, entry.image), `references/${entry.image}`, 'user-supplied-research-reference');
const manifest = { schemaVersion: 'nexiom.visual-design-bundle/1', version: '1.7.1', importedAt: new Date().toISOString(), sourceDirectory: source, sourceVersions: { upstreamVisualization: '1.7.1', studio: '0.1.0' }, adaptations: ['Native JSON worker and NEXIOM dynamic functions replace the MCP protocol and SDK', 'Python business package renamed nexiom_visualization', 'External PaperSpec transport removed; NEXIOM Responses adapter owns transport', 'Original configuration-center access removed; NEXIOM provider stdin is authoritative', 'Original source terms referencing PaperSpec replaced with current-project evidence', 'All templates, data, palettes and previews use package-relative paths'], license: 'Upstream projects contain no LICENSE file. Imported for the owner’s existing local NEXIOM workspace; upstream reference attribution is retained.', excluded: ['MCP SDK/server', 'PaperSpec package and schemas', 'model registry', 'credentials and .env', 'runs', 'caches', 'virtual environments', 'Studio UI screenshots and logs'], files };
await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const result = spawnSync(process.env.NEXIOM_PYTHON || 'python', ['-B', path.join(destination, 'export_catalog.py')], { cwd: repo, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Imported ${files.length} files (${(files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1)} MiB).`);

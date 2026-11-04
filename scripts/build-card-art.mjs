#!/usr/bin/env node
/**
 * Build the card-art folder that ships with the client.
 *
 * Sources (kept out of the repo; see README):
 *   assets-private/balatro-backs/1x/*.png           71x95 deck backs
 *   assets-private/balatro-foj/<suit>__<name>.png   426x190 sprite of J, Q, K
 *
 * Output (bundled by Vite into dist/public/assets and committed):
 *   src/client/assets/card-art/manifest.json
 *   src/client/assets/card-art/backs/<id>.png
 *   src/client/assets/card-art/faces/<suit>-<id>.png
 *
 * The art is third-party fan material for a private table: it is part of the
 * normal build, but do not redistribute the repository or the build publicly.
 *
 * Usage: node scripts/build-card-art.mjs [--root <dir>]
 */
import { cp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const root = path.resolve(rootFlag >= 0 ? args[rootFlag + 1] : path.join(repoRoot, 'assets-private'))

const BACKS = [
  ['Red', 'red', 'Red'],
  ['Blue', 'blue', 'Blue'],
  ['Yellow', 'yellow', 'Yellow'],
  ['Green', 'green', 'Green'],
  ['Black', 'black', 'Black'],
  ['Magic', 'magic', 'Magic'],
  ['Nebula', 'nebula', 'Nebula'],
  ['Ghost', 'ghost', 'Ghost'],
  ['Abandoned', 'abandoned', 'Abandoned'],
  ['Checkered', 'checkered', 'Checkered'],
  ['Zodiac', 'zodiac', 'Zodiac'],
  ['Painted', 'painted', 'Painted'],
  ['Anaglyph', 'anaglyph', 'Anaglyph'],
  ['Plasma', 'plasma', 'Plasma'],
  ['Erratic', 'erratic', 'Erratic'],
  ['Challenge', 'challenge', 'Challenge'],
]

/** suit, source file stem (after the "<suit>__" prefix), id, label */
const FACES = [
  ['spades', 'The_Witcher_III', 'witcher-3', 'The Witcher III'],
  ['spades', 'Cyberpunk_2077', 'cyberpunk-2077', 'Cyberpunk 2077'],
  ['spades', 'Shovel_Knight', 'shovel-knight', 'Shovel Knight'],
  ['spades', 'Don_t_Starve', 'dont-starve', "Don't Starve"],
  ['spades', 'Assassin_s_Creed', 'assassins-creed', "Assassin's Creed"],
  ['spades', 'Slay_the_Princess', 'slay-the-princess', 'Slay the Princess'],
  ['hearts', 'Among_Us', 'among-us', 'Among Us'],
  ['hearts', 'Binding_of_Isaac', 'binding-of-isaac', 'Binding of Isaac'],
  ['hearts', 'Cult_of_the_Lamb', 'cult-of-the-lamb', 'Cult of the Lamb'],
  ['hearts', 'Divinity_OS_2', 'divinity-os-2', 'Divinity: Original Sin 2'],
  ['hearts', 'Critical_Role', 'critical-role', 'Critical Role'],
  ['hearts', 'Bugsnax', 'bugsnax', 'Bugsnax'],
  ['clubs', 'Vampire_Survivors', 'vampire-survivors', 'Vampire Survivors'],
  ['clubs', 'Slay_the_Spire', 'slay-the-spire', 'Slay the Spire'],
  ['clubs', 'Potion_Craft', 'potion-craft', 'Potion Craft'],
  ['clubs', 'Warframe', 'warframe', 'Warframe'],
  ['clubs', 'Dead_by_Daylight', 'dead-by-daylight', 'Dead by Daylight'],
  ['clubs', 'Fallout', 'fallout', 'Fallout'],
  ['diamonds', 'Dave_the_Diver', 'dave-the-diver', 'Dave the Diver'],
  ['diamonds', 'Stardew_Valley', 'stardew-valley', 'Stardew Valley'],
  ['diamonds', 'Enter_the_Gungeon', 'enter-the-gungeon', 'Enter the Gungeon'],
  ['diamonds', '1000xRESIST', '1000xresist', '1000xRESIST'],
  ['diamonds', 'Civilization_VII', 'civilization-vii', 'Civilization VII'],
  ['diamonds', 'Rust', 'rust', 'Rust'],
]

function fail(message) {
  console.error(`[card-art] ${message}`)
  process.exitCode = 1
}

async function listPngs(dir) {
  try {
    const entries = await readdir(dir)
    return new Set(entries.filter(name => name.toLowerCase().endsWith('.png')).map(name => name.toLowerCase()))
  } catch (error) {
    if (error.code === 'ENOENT') return new Set()
    throw error
  }
}

async function main() {
  const backsDir = path.join(root, 'balatro-backs', '1x')
  const facesDir = path.join(root, 'balatro-foj')
  const outDir = path.join(repoRoot, 'src', 'client', 'assets', 'card-art')

  const availableBacks = await listPngs(backsDir)
  const availableFaces = await listPngs(facesDir)
  if (availableBacks.size === 0) {
    fail(`no deck backs found in ${backsDir}; run the download step first`)
    return
  }

  await rm(outDir, { recursive: true, force: true })
  await mkdir(path.join(outDir, 'backs'), { recursive: true })
  await mkdir(path.join(outDir, 'faces'), { recursive: true })

  const backs = []
  for (const [file, id, label] of BACKS) {
    const nombre = `${file}.png`
    if (!availableBacks.has(nombre.toLowerCase())) {
      console.warn(`[card-art] skipping missing back ${nombre}`)
      continue
    }
    await cp(path.join(backsDir, nombre), path.join(outDir, 'backs', `${id}.png`))
    backs.push({ id, label })
  }

  const faces = []
  for (const [suit, stem, id, label] of FACES) {
    const nombre = `${suit}__${stem}.png`
    if (!availableFaces.has(nombre.toLowerCase())) {
      console.warn(`[card-art] skipping missing face set ${nombre}`)
      continue
    }
    await cp(path.join(facesDir, nombre), path.join(outDir, 'faces', `${suit}-${id}.png`))
    faces.push({ suit, id, label })
  }

  const manifest = { version: 1, backs, faces }
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const readme = [
    'Balatro-derived card art for a private table.',
    'Generated by scripts/build-card-art.mjs; do not edit by hand.',
    '',
    `backs: ${backs.length}`,
    `face sets: ${faces.length} (${faces.length * 3} face cards)`,
    '',
  ].join('\n')
  await writeFile(path.join(outDir, 'README.txt'), readme, 'utf8')

  console.log(`[card-art] wrote ${outDir}`)
  console.log(`[card-art] ${backs.length} backs, ${faces.length} face sets (${faces.length * 3} cards)`)
}

await main()

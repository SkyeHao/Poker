import React, { createContext, useContext } from 'react'
import type { Suit } from '../engine/poker.ts'
import type { Cosmetics } from '../protocol/index.ts'
import manifest from './assets/card-art/manifest.json'

export interface CardArtBack {
  id: string
  label: string
}

export interface CardArtFaceSet {
  suit: Suit
  id: string
  label: string
}

export interface CardArtCatalog {
  backs: CardArtBack[]
  faces: CardArtFaceSet[]
}

export const EMPTY_COSMETICS: Cosmetics = {
  back: '',
  faces: { spades: '', hearts: '', clubs: '', diamonds: '' },
}

export const EMPTY_CATALOG: CardArtCatalog = { backs: [], faces: [] }

/**
 * The art is bundled: Vite imports every PNG with a content hash, so a deploy
 * that ships `dist/public/assets` always carries the cards with it.
 */
const backFiles = import.meta.glob('./assets/card-art/backs/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const faceFiles = import.meta.glob('./assets/card-art/faces/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function fileId(key: string): string {
  const file = key.slice(key.lastIndexOf('/') + 1)
  return file.endsWith('.png') ? file.slice(0, -4) : file
}

const backUrls = new Map<string, string>()
for (const [key, url] of Object.entries(backFiles)) backUrls.set(fileId(key), url)

const faceUrls = new Map<string, string>()
for (const [key, url] of Object.entries(faceFiles)) faceUrls.set(fileId(key), url)

const SUITS = new Set<string>(['spades', 'hearts', 'clubs', 'diamonds'])

/** Only entries whose file made it into the bundle are advertised. */
const CATALOG: CardArtCatalog = {
  backs: manifest.backs.flatMap(entry => (
    backUrls.has(entry.id) ? [{ id: entry.id, label: entry.label }] : []
  )),
  faces: manifest.faces.flatMap(entry => {
    if (!SUITS.has(entry.suit)) return []
    if (!faceUrls.has(`${entry.suit}-${entry.id}`)) return []
    return [{ suit: entry.suit as Suit, id: entry.id, label: entry.label }]
  }),
}

export function cardArtCatalog(): CardArtCatalog {
  return CATALOG
}

export function backUrl(id: string): string {
  return backUrls.get(id) ?? ''
}

export function faceSetUrl(suit: Suit, id: string): string {
  return faceUrls.get(`${suit}-${id}`) ?? ''
}

export function backById(catalog: CardArtCatalog, id: string): CardArtBack | undefined {
  return catalog.backs.find(back => back.id === id)
}

export function faceSetById(catalog: CardArtCatalog, suit: Suit, id: string): CardArtFaceSet | undefined {
  return catalog.faces.find(set => set.suit === suit && set.id === id)
}

export function catalogIsEmpty(catalog: CardArtCatalog): boolean {
  return catalog.backs.length === 0 && catalog.faces.length === 0
}

interface CardArtValue {
  catalog: CardArtCatalog
  cosmetics: Cosmetics
  back: CardArtBack | undefined
  faceSets: Record<Suit, CardArtFaceSet | undefined>
}

const CardArtContext = createContext<CardArtValue>({
  catalog: EMPTY_CATALOG,
  cosmetics: EMPTY_COSMETICS,
  back: undefined,
  faceSets: { spades: undefined, hearts: undefined, clubs: undefined, diamonds: undefined },
})

export function CardArtProvider({ catalog, cosmetics, children }: {
  catalog: CardArtCatalog
  cosmetics: Cosmetics
  children: React.ReactNode
}): React.ReactElement {
  const value: CardArtValue = {
    catalog,
    cosmetics,
    back: backById(catalog, cosmetics.back),
    faceSets: {
      spades: faceSetById(catalog, 'spades', cosmetics.faces.spades),
      hearts: faceSetById(catalog, 'hearts', cosmetics.faces.hearts),
      clubs: faceSetById(catalog, 'clubs', cosmetics.faces.clubs),
      diamonds: faceSetById(catalog, 'diamonds', cosmetics.faces.diamonds),
    },
  }
  return <CardArtContext.Provider value={value}>{children}</CardArtContext.Provider>
}

export function useCardArt(): CardArtValue {
  return useContext(CardArtContext)
}

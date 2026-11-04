import React, { useState } from 'react'
import type { Suit } from '../engine/poker.ts'
import type { Cosmetics } from '../protocol/index.ts'
import { backUrl, faceSetUrl, type CardArtCatalog } from './cardArt.tsx'
import type { Translate } from './i18n.ts'

const SUITS: readonly Suit[] = ['spades', 'hearts', 'clubs', 'diamonds']

function suitGlyph(suit: Suit): string {
  switch (suit) {
    case 'spades': return '♠'
    case 'hearts': return '♥'
    case 'clubs': return '♣'
    case 'diamonds': return '♦'
  }
}

function suitKey(suit: Suit): 'suitSpades' | 'suitHearts' | 'suitClubs' | 'suitDiamonds' {
  switch (suit) {
    case 'spades': return 'suitSpades'
    case 'hearts': return 'suitHearts'
    case 'clubs': return 'suitClubs'
    case 'diamonds': return 'suitDiamonds'
  }
}

type Tab = 'backs' | 'faces'

/** Shared picker for the player panel and the admin override. */
export function CosmeticsPicker({ catalog, value, disabled = false, facesDisabled = false, allowFaces = true, allowBacks = true, onChange, t }: {
  catalog: CardArtCatalog
  value: Cosmetics
  disabled?: boolean
  facesDisabled?: boolean
  allowFaces?: boolean
  allowBacks?: boolean
  onChange: (cosmetics: Cosmetics) => void
  t: Translate
}): React.ReactElement {
  const [tab, setTab] = useState<Tab>(allowBacks ? 'backs' : 'faces')
  const active: Tab = !allowBacks ? 'faces' : !allowFaces ? 'backs' : tab
  const setBack = (id: string): void => { onChange({ ...value, back: id }) }
  const setFace = (suit: Suit, id: string): void => {
    onChange({ ...value, faces: { ...value.faces, [suit]: id } })
  }

  return (
    <div className="poker-cosmetics">
      {allowBacks && allowFaces ? (
        <div className="poker-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="poker-tab"
            data-active={active === 'backs'}
            aria-selected={active === 'backs'}
            onClick={() => { setTab('backs') }}
          >
            {t('cosmeticsTabBacks')}<span className="poker-tab-count">{catalog.backs.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            className="poker-tab"
            data-active={active === 'faces'}
            aria-selected={active === 'faces'}
            onClick={() => { setTab('faces') }}
          >
            {t('cosmeticsTabFaces')}<span className="poker-tab-count">{catalog.faces.length}</span>
          </button>
        </div>
      ) : null}

      {active === 'backs' ? (
        <div className="poker-swatch-grid">
          <button
            type="button"
            className="poker-swatch"
            data-active={value.back === ''}
            disabled={disabled}
            onClick={() => { setBack('') }}
          >
            <span className="poker-swatch-art poker-swatch-default">♠</span>
            <span className="poker-swatch-label">{t('cosmeticsDefault')}</span>
          </button>
          {catalog.backs.map(back => (
            <button
              key={back.id}
              type="button"
              className="poker-swatch"
              data-active={value.back === back.id}
              disabled={disabled}
              title={back.label}
              onClick={() => { setBack(back.id) }}
            >
              <span className="poker-swatch-art" style={{ backgroundImage: `url(${backUrl(back.id)})` }} />
              <span className="poker-swatch-label">{back.label}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="poker-cosmetics-suits">
          {SUITS.map(suit => {
            const sets = catalog.faces.filter(set => set.suit === suit)
            if (sets.length === 0) return null
            const current = value.faces[suit]
            const currentLabel = current === ''
              ? t('cosmeticsDefault')
              : sets.find(set => set.id === current)?.label ?? current
            return (
              <section key={suit} className="poker-cosmetics-suit">
                <header className="poker-cosmetics-suit-head">
                  <span className="poker-cosmetics-suit-name" data-red={suit === 'hearts' || suit === 'diamonds'}>
                    {suitGlyph(suit)} {t(suitKey(suit))}
                  </span>
                  <span className="poker-cosmetics-current">{t('cosmeticsCurrent', { name: currentLabel })}</span>
                  <button
                    type="button"
                    className="poker-btn"
                    data-size="sm"
                    data-variant="ghost"
                    disabled={current === '' || facesDisabled}
                    onClick={() => { setFace(suit, '') }}
                  >
                    {t('cosmeticsReset')}
                  </button>
                </header>
                <div className="poker-swatch-grid poker-swatch-grid--faces">
                  {sets.map(set => (
                    <button
                      key={set.id}
                      type="button"
                      className="poker-swatch"
                      data-active={current === set.id}
                      disabled={facesDisabled}
                      title={set.label}
                      onClick={() => { setFace(suit, set.id) }}
                    >
                      <span
                        className="poker-swatch-art poker-swatch-face"
                        style={{ backgroundImage: `url(${faceSetUrl(suit, set.id)})` }}
                      />
                      <span className="poker-swatch-label">{set.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Player-facing modal: changes apply immediately and are stored on the room record. */
export function CosmeticsPanel({ catalog, value, overridden, onApply, onClose, t }: {
  catalog: CardArtCatalog
  value: Cosmetics
  overridden: boolean
  onApply: (cosmetics: Cosmetics) => void
  onClose: () => void
  t: Translate
}): React.ReactElement {
  return (
    <div className="poker-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="poker-modal poker-modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t('cosmeticsTitle')}
        onClick={event => { event.stopPropagation() }}
      >
        <div className="poker-modal-head">
          <div>
            <h2>{t('cosmeticsTitle')}</h2>
            {overridden ? null : <p className="poker-note">{t('cosmeticsHint')}</p>}
          </div>
          <button type="button" className="poker-btn" data-size="sm" onClick={onClose}>{t('close')}</button>
        </div>
        {overridden ? <p className="poker-banner" data-tone="warn">{t('cosmeticsLocked')}</p> : null}
        <CosmeticsPicker
          catalog={catalog}
          value={value}
          disabled={overridden}
          onChange={onApply}
          t={t}
        />
      </div>
    </div>
  )
}

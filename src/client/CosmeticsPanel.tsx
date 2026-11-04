import React from 'react'
import type { Suit } from '../engine/poker.ts'
import type { Cosmetics } from '../protocol/index.ts'
import { backUrl, faceSetUrl, type CardArtCatalog } from './cardArt.tsx'
import type { Translate } from './i18n.ts'

const SUITS: readonly Suit[] = ['spades', 'hearts', 'clubs', 'diamonds']

function suitLabel(suit: Suit): string {
  switch (suit) {
    case 'spades': return '♠'
    case 'hearts': return '♥'
    case 'clubs': return '♣'
    case 'diamonds': return '♦'
  }
}

/** Shared swatch grids for the player panel and the admin override. */
export function CosmeticsPicker({ catalog, value, disabled = false, onChange, t }: {
  catalog: CardArtCatalog
  value: Cosmetics
  disabled?: boolean
  onChange: (cosmetics: Cosmetics) => void
  t: Translate
}): React.ReactElement {
  const setBack = (id: string): void => { onChange({ ...value, back: id }) }
  const setFace = (suit: Suit, id: string): void => {
    onChange({ ...value, faces: { ...value.faces, [suit]: id } })
  }

  return (
    <div className="poker-cosmetics">
      <section className="poker-drawer-section">
        <h3>{t('cosmeticsBack')}</h3>
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
      </section>

      <section className="poker-drawer-section">
        <h3>{t('cosmeticsFaces')}</h3>
        <p className="poker-note">{t('cosmeticsFacesHint')}</p>
        {SUITS.map(suit => {
          const sets = catalog.faces.filter(set => set.suit === suit)
          if (sets.length === 0) return null
          return (
            <div key={suit} className="poker-cosmetics-suit">
              <span className="poker-cosmetics-suit-name" data-red={suit === 'hearts' || suit === 'diamonds'}>
                {suitLabel(suit)}
              </span>
              <div className="poker-swatch-row">
                <button
                  type="button"
                  className="poker-swatch"
                  data-active={value.faces[suit] === ''}
                  data-compact="true"
                  disabled={disabled}
                  title={t('cosmeticsDefault')}
                  onClick={() => { setFace(suit, '') }}
                >
                  <span className="poker-swatch-art poker-swatch-default">J</span>
                </button>
                {sets.map(set => (
                  <button
                    key={set.id}
                    type="button"
                    className="poker-swatch"
                    data-active={value.faces[suit] === set.id}
                    data-compact="true"
                    disabled={disabled}
                    title={set.label}
                    onClick={() => { setFace(suit, set.id) }}
                  >
                    <span
                      className="poker-swatch-art poker-swatch-face"
                      style={{ backgroundImage: `url(${faceSetUrl(suit, set.id)})` }}
                    />
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </section>
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
            <p className="poker-note">{t('cosmeticsHint')}</p>
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

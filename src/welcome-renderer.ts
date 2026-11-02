import type { OperatingMode } from './operating-mode'

declare global {
  interface Window {
    karaokeWelcome?: { chooseMode(mode: OperatingMode): Promise<void> }
  }
}

const cards = [...document.querySelectorAll<HTMLButtonElement>('.mode-card')]
const continueButton = document.querySelector<HTMLButtonElement>('#welcome-continue')!
const errorText = document.querySelector<HTMLElement>('#welcome-error')!
let selectedMode: OperatingMode | undefined
let submitting = false

function selectCard(card: HTMLButtonElement): void {
  const mode = card.dataset.mode
  if (mode !== 'controller' && mode !== 'player' && mode !== 'combined') return
  selectedMode = mode
  for (const item of cards) {
    const selected = item === card
    item.setAttribute('aria-checked', String(selected))
    item.tabIndex = selected ? 0 : -1
    item.classList.toggle('is-selected', selected)
  }
  continueButton.disabled = submitting || !selectedMode
}

for (const [index, card] of cards.entries()) {
  card.tabIndex = index === 0 ? 0 : -1
  card.addEventListener('click', () => selectCard(card))
  card.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowRight' &&
        event.key !== 'ArrowUp' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (index + direction + cards.length) % cards.length
    cards[nextIndex].focus()
    selectCard(cards[nextIndex])
  })
}

continueButton.addEventListener('click', async () => {
  if (!selectedMode || submitting) return
  submitting = true
  continueButton.disabled = true
  errorText.hidden = true
  try {
    if (!window.karaokeWelcome) throw new Error('A configuração inicial não está disponível.')
    await window.karaokeWelcome.chooseMode(selectedMode)
  } catch {
    submitting = false
    continueButton.disabled = false
    errorText.textContent = 'Não foi possível salvar o modo. O estado atual foi preservado; tente novamente.'
    errorText.hidden = false
  }
})

document.querySelector<HTMLButtonElement>('#welcome-cancel')!.addEventListener('click', () => window.close())

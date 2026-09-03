// Spoken prompts via the Web Speech API. Degrades to a no-op when missing.

export class Voice {
  constructor({ enabled = true } = {}) {
    this.synth = globalThis.speechSynthesis || null;
    this.enabled = enabled;
    this.voice = null;
    this.unlocked = false;
    if (this.synth) {
      const pick = () => (this.voice = pickVoice(this.synth.getVoices()));
      pick();
      this.synth.addEventListener?.('voiceschanged', pick);
    }
  }

  get available() {
    return !!this.synth && typeof globalThis.SpeechSynthesisUtterance === 'function';
  }

  /** Must be called from a user gesture on iOS before speech works. */
  unlock() {
    if (!this.available || this.unlocked) return;
    this.unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    } catch {
      /* ignore */
    }
  }

  speak(text, { priority = false } = {}) {
    if (!this.enabled || !this.available || !text) return;
    try {
      if (priority) this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice?.lang || globalThis.navigator?.language || 'en';
      u.rate = 1.0;
      this.synth.speak(u);
    } catch {
      /* ignore */
    }
  }

  stop() {
    try {
      this.synth?.cancel();
    } catch {
      /* ignore */
    }
  }
}

function pickVoice(voices) {
  if (!voices?.length) return null;
  const lang = (globalThis.navigator?.language || 'en').toLowerCase();
  const exact = voices.filter((v) => v.lang?.toLowerCase() === lang);
  const sameLang = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang.split('-')[0]));
  const pool = exact.length ? exact : sameLang.length ? sameLang : voices;
  // Prefer local, non-novelty voices; Google/Apple voices tend to be clearest.
  return (
    pool.find((v) => v.localService && /google|samantha|daniel|karen|moira|siri/i.test(v.name)) ||
    pool.find((v) => v.localService) ||
    pool[0]
  );
}

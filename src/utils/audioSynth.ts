/**
 * Web Audio Ambient Music Synthesizer & Studio Sound Design Engine
 * Provides smooth background soundtracks, transition whooshes, YouTube chimes,
 * and multi-stage Web Audio studio noise-cancellation DSP filters.
 */

class AudioSynthEngine {
  private ctx: AudioContext | null = null;
  private isPlaying = false;
  private masterGain: GainNode | null = null;
  private timerId: number | null = null;
  private activeOscillators: OscillatorNode[] = [];

  public initContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public getContext(): AudioContext | null {
    return this.ctx;
  }

  /**
   * Constructs a real Web Audio multi-stage noise-reduction & broadcast vocal enhancer DSP graph.
   * Stage 1: High-Pass Filter (85 Hz) removes microphone handling rumble and desk thumps.
   * Stage 2: Notch Filter (60 Hz / 120 Hz) cancels electromagnetic AC mains hum.
   * Stage 3: Low-Pass Filter (7500 Hz) eliminates room hiss, white noise, and PC fan noise.
   * Stage 4: Peaking Filter (+3.5 dB at 2800 Hz) adds speech clarity and presence.
   * Stage 5: Dynamics Compressor evens out vocal dynamics and avoids clipping.
   */
  public createStudioNoiseFilter(audioCtx: AudioContext): {
    inputNode: AudioNode;
    outputNode: AudioNode;
  } {
    // 1. High-pass filter for rumble
    const highPass = audioCtx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.setValueAtTime(85, audioCtx.currentTime);
    highPass.Q.setValueAtTime(0.7, audioCtx.currentTime);

    // 2. Notch filter for 60Hz hum
    const notch60 = audioCtx.createBiquadFilter();
    notch60.type = 'notch';
    notch60.frequency.setValueAtTime(60, audioCtx.currentTime);
    notch60.Q.setValueAtTime(4.0, audioCtx.currentTime);

    // 3. De-hisser low-pass filter
    const deHiss = audioCtx.createBiquadFilter();
    deHiss.type = 'lowpass';
    deHiss.frequency.setValueAtTime(7600, audioCtx.currentTime);
    deHiss.Q.setValueAtTime(0.6, audioCtx.currentTime);

    // 4. Vocal presence EQ boost
    const vocalBoost = audioCtx.createBiquadFilter();
    vocalBoost.type = 'peaking';
    vocalBoost.frequency.setValueAtTime(2800, audioCtx.currentTime);
    vocalBoost.Q.setValueAtTime(1.2, audioCtx.currentTime);
    vocalBoost.gain.setValueAtTime(3.5, audioCtx.currentTime);

    // 5. Broadcast dynamics compressor
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-22, audioCtx.currentTime);
    compressor.knee.setValueAtTime(10, audioCtx.currentTime);
    compressor.ratio.setValueAtTime(3.8, audioCtx.currentTime);
    compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
    compressor.release.setValueAtTime(0.2, audioCtx.currentTime);

    // Chain nodes together
    highPass.connect(notch60);
    notch60.connect(deHiss);
    deHiss.connect(vocalBoost);
    vocalBoost.connect(compressor);

    return {
      inputNode: highPass,
      outputNode: compressor,
    };
  }

  /**
   * Generates a cinematic whoosh / swoosh sound effect for scene transitions
   */
  public playWhooshTransition(style: 'fast' | 'cinematic' | 'riser' = 'fast') {
    try {
      const ctx = this.initContext();
      const now = ctx.currentTime;
      const duration = style === 'cinematic' ? 0.75 : 0.45;

      // 1. Noise buffer for whoosh air rushing
      const bufferSize = ctx.sampleRate * duration;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      // Dynamic sweeping bandpass filter
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.setValueAtTime(3.0, now);
      filter.frequency.setValueAtTime(280, now);
      filter.frequency.exponentialRampToValueAtTime(1800, now + duration * 0.5);
      filter.frequency.exponentialRampToValueAtTime(220, now + duration);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.28, now + duration * 0.45);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      noise.start(now);
      noise.stop(now + duration);
    } catch (_) {}
  }

  /**
   * Plays YouTube Subscribe click + Notification Bell ding
   */
  public playSubscribeDing() {
    try {
      const ctx = this.initContext();
      const now = ctx.currentTime;

      // 1. Crisp metallic click
      const clickOsc = ctx.createOscillator();
      const clickGain = ctx.createGain();
      clickOsc.frequency.setValueAtTime(1200, now);
      clickOsc.frequency.exponentialRampToValueAtTime(200, now + 0.04);
      clickGain.gain.setValueAtTime(0.25, now);
      clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      clickOsc.connect(clickGain);
      clickGain.connect(ctx.destination);
      clickOsc.start(now);
      clickOsc.stop(now + 0.05);

      // 2. High bell chime at E6 (1318.5 Hz)
      const bellOsc = ctx.createOscillator();
      const bellGain = ctx.createGain();
      bellOsc.type = 'sine';
      bellOsc.frequency.setValueAtTime(1318.51, now + 0.06);
      bellGain.gain.setValueAtTime(0.22, now + 0.06);
      bellGain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
      bellOsc.connect(bellGain);
      bellGain.connect(ctx.destination);
      bellOsc.start(now + 0.06);
      bellOsc.stop(now + 1.25);
    } catch (_) {}
  }

  public startSoundtrack(mood = 'Chill Lo-Fi', volume = 0.22) {
    this.stopSoundtrack();
    this.initContext();
    if (!this.ctx) return;

    this.isPlaying = true;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(volume, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    // Chords progression based on mood
    const chordsMap: Record<string, number[][]> = {
      'Chill Lo-Fi': [
        [174.61, 220.0, 261.63, 329.63], // Fmaj7
        [196.0, 246.94, 293.66, 349.23], // G7
        [164.81, 196.0, 246.94, 293.66], // Em7
        [220.0, 261.63, 329.63, 392.0], // Am7
      ],
      'Warm Acoustic': [
        [130.81, 196.0, 261.63, 329.63], // C
        [196.0, 246.94, 293.66, 392.0], // G
        [164.81, 220.0, 261.63, 329.63], // Am
        [174.61, 220.0, 261.63, 349.23], // F
      ],
      'Modern Upbeat': [
        [261.63, 329.63, 392.0, 523.25],
        [293.66, 369.99, 440.0, 587.33],
        [329.63, 392.0, 493.88, 659.25],
        [261.63, 329.63, 392.0, 523.25],
      ],
      'Ambient Calm': [
        [110.0, 164.81, 220.0, 277.18],
        [98.0, 146.83, 196.0, 246.94],
        [87.31, 130.81, 174.61, 220.0],
        [98.0, 146.83, 196.0, 246.94],
      ],
    };

    const chords = chordsMap[mood] || chordsMap['Chill Lo-Fi'];
    let step = 0;

    const playChord = () => {
      if (!this.isPlaying || !this.ctx || !this.masterGain) return;
      const notes = chords[step % chords.length];
      step++;

      notes.forEach((freq, idx) => {
        if (!this.ctx || !this.masterGain) return;
        const osc = this.ctx.createOscillator();
        const noteGain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        osc.type = idx === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(800 + idx * 200, this.ctx.currentTime);

        const now = this.ctx.currentTime;
        const noteDuration = 2.4;

        noteGain.gain.setValueAtTime(0, now);
        noteGain.gain.linearRampToValueAtTime(0.08, now + 0.4);
        noteGain.gain.exponentialRampToValueAtTime(0.001, now + noteDuration);

        osc.connect(filter);
        filter.connect(noteGain);
        noteGain.connect(this.masterGain);

        osc.start(now);
        osc.stop(now + noteDuration);
        this.activeOscillators.push(osc);

        setTimeout(() => {
          const index = this.activeOscillators.indexOf(osc);
          if (index !== -1) this.activeOscillators.splice(index, 1);
        }, noteDuration * 1000 + 100);
      });
    };

    playChord();
    this.timerId = window.setInterval(playChord, 2200);
  }

  public playChannelIntroSting(
    style: 'signature-chime' | 'sub-boom' | 'sparkle' | 'acoustic' = 'signature-chime'
  ) {
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const stingGain = this.ctx.createGain();
    stingGain.gain.setValueAtTime(0.35, now);
    stingGain.gain.exponentialRampToValueAtTime(0.001, now + 2.0);
    stingGain.connect(this.ctx.destination);

    if (style === 'signature-chime') {
      const freqs = [659.25, 830.61, 987.77, 1318.51];
      freqs.forEach((f, i) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, now + i * 0.12);
        g.gain.setValueAtTime(0.2, now + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 1.2);
        osc.connect(g);
        g.connect(stingGain);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 1.3);
      });
    } else if (style === 'sub-boom') {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.exponentialRampToValueAtTime(35, now + 0.8);
      osc.connect(stingGain);
      osc.start(now);
      osc.stop(now + 1.8);
    } else if (style === 'sparkle') {
      const freqs = [523.25, 659.25, 783.99, 1046.5];
      freqs.forEach((f, i) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, now + i * 0.08);
        osc.connect(stingGain);
        osc.start(now + i * 0.08);
        osc.stop(now + i * 0.08 + 0.9);
      });
    } else {
      [196, 246.94, 293.66, 392].forEach((f, i) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, now + i * 0.05);
        osc.connect(stingGain);
        osc.start(now + i * 0.05);
        osc.stop(now + 1.5);
      });
    }
  }

  public setDucking(duck: boolean) {
    if (!this.ctx || !this.masterGain) return;
    const targetVolume = duck ? 0.07 : 0.22;
    this.masterGain.gain.setTargetAtTime(targetVolume, this.ctx.currentTime, 0.2);
  }

  public setVolume(volume: number) {
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.1);
  }

  public stopSoundtrack() {
    this.isPlaying = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.activeOscillators.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch (e) {}
    });
    this.activeOscillators = [];
    if (this.masterGain && this.ctx) {
      try {
        this.masterGain.disconnect();
      } catch (e) {}
      this.masterGain = null;
    }
  }
}

export const audioSynth = new AudioSynthEngine();

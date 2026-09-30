'use strict';

var DEFAULT_PARAMS = {
  distance: 0.34,
  snow: 0.48,
  air: 0.42,
  slap: 0.4,
  pa: 0.2,
  mix: 0.4,
  level: 0.8,
};

var KNOB_SPECS = [
  { id: 'distance', name: 'Distance', hint: 'Farther away', label: 'Distance' },
  { id: 'snow', name: 'Snow', hint: 'Highs sink', label: 'Snow absorption' },
  { id: 'air', name: 'Air', hint: 'Tail length', label: 'Air, tail length' },
  { id: 'slap', name: 'Slap', hint: 'Hill echoes', label: 'Slap, sparse echoes' },
  { id: 'pa', name: 'PA', hint: 'Megaphone', label: 'PA / Megaphone' },
  { id: 'mix', name: 'Mix', hint: 'Dry / wet', label: 'Mix' },
  { id: 'level', name: 'Level', hint: 'Output', label: 'Level' },
];

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function formatClock(seconds) {
  var safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  var whole = Math.floor(safe);
  var minutes = Math.floor(whole / 60);
  var remain = whole % 60;
  if (minutes >= 100) {
    var hours = Math.floor(minutes / 60);
    var minutePart = minutes % 60;
    return hours + ':' + String(minutePart).padStart(2, '0') + ':' + String(remain).padStart(2, '0');
  }
  return minutes + ':' + String(remain).padStart(2, '0');
}

function mapSkiParameters(params) {
  var distance = clamp01(params.distance);
  var snow = clamp01(params.snow);
  var air = clamp01(params.air);
  var slap = clamp01(params.slap);
  var pa = clamp01(params.pa);
  var mix = clamp01(params.mix);
  var level = clamp01(params.level);
  var angle = mix * Math.PI * 0.5;
  var snowCurve = Math.pow(snow, 0.85);
  var slapTimes = [
    0.09 + distance * 0.05,
    0.175 + distance * 0.08,
    0.27 + distance * 0.07,
  ];
  var boundedTimes = [];
  for (var timeIndex = 0; timeIndex < slapTimes.length; timeIndex++) {
    var time = slapTimes[timeIndex];
    if (time < 0.08) time = 0.08;
    if (time > 0.35) time = 0.35;
    boundedTimes.push(time);
  }
  return {
    predelay: 0.008 + distance * 0.072,
    dryLowpass: lerp(17000, 3600, distance),
    dryGain: Math.cos(angle) * lerp(1, 0.6, distance),
    wetGain: Math.sin(angle),
    wetSend: lerp(0.85, 1.12, distance),
    slapTimes: boundedTimes,
    slapGains: [slap * 0.78, slap * 0.5, slap * 0.26],
    slapPans: [-0.55, 0.68, 0.12],
    slapCutoff: lerp(6400, 700, snowCurve),
    lateCutoff: lerp(6800, 680, snowCurve),
    irDuration: 0.8 + air * 3.2,
    paDry: 1 - pa,
    paWet: pa,
    paHighpass: lerp(260, 430, pa),
    paLowpass: lerp(4200, 2400, pa),
    masterGain: level,
  };
}

function createRandom(seed) {
  var state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    var mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function clampFrequency(cutoff, sampleRate) {
  var nyquist = sampleRate * 0.45;
  if (cutoff < 40) return 40;
  if (cutoff > nyquist) return nyquist;
  return cutoff;
}

function designLowpass(cutoff, sampleRate, q) {
  var frequency = clampFrequency(cutoff, sampleRate);
  var omega = 2 * Math.PI * frequency / sampleRate;
  var cosine = Math.cos(omega);
  var alpha = Math.sin(omega) / (2 * q);
  var b0 = (1 - cosine) / 2;
  var b1 = 1 - cosine;
  var b2 = (1 - cosine) / 2;
  var a0 = 1 + alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  };
}

function designHighpass(cutoff, sampleRate, q) {
  var frequency = clampFrequency(cutoff, sampleRate);
  var omega = 2 * Math.PI * frequency / sampleRate;
  var cosine = Math.cos(omega);
  var alpha = Math.sin(omega) / (2 * q);
  var b0 = (1 + cosine) / 2;
  var b1 = -(1 + cosine);
  var b2 = (1 + cosine) / 2;
  var a0 = 1 + alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  };
}

function applyBiquad(data, coeffs) {
  var x1 = 0;
  var x2 = 0;
  var y1 = 0;
  var y2 = 0;
  for (var sampleIndex = 0; sampleIndex < data.length; sampleIndex++) {
    var x0 = data[sampleIndex];
    var y0 = coeffs.b0 * x0 + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    data[sampleIndex] = y0;
  }
}

function lowpassInPlace(data, sampleRate, cutoff, q) {
  applyBiquad(data, designLowpass(cutoff, sampleRate, q));
}

function highpassInPlace(data, sampleRate, cutoff, q) {
  applyBiquad(data, designHighpass(cutoff, sampleRate, q));
}

// ConvolverNode with normalize=false amplifies by about RMS(ir) * sqrt(length).
// Scale the noise so a full-scale input returns near targetGain; otherwise a
// multi-second tail becomes a loud hall instead of a thin outdoor wash.
function scaleForConvolution(data, targetGain) {
  var sumSquares = 0;
  for (var sampleIndex = 0; sampleIndex < data.length; sampleIndex++) {
    var sample = data[sampleIndex];
    sumSquares += sample * sample;
  }
  var rms = Math.sqrt(sumSquares / data.length);
  var estimatedGain = rms * Math.sqrt(data.length);
  if (estimatedGain < 1e-8) return;
  var scale = targetGain / estimatedGain;
  if (scale > 80) scale = 80;
  for (var gainIndex = 0; gainIndex < data.length; gainIndex++) {
    data[gainIndex] *= scale;
  }
}

function renderSkiImpulseResponse(sampleRate, durationSec, snowAmount) {
  var snow = clamp01(snowAmount);
  var duration = durationSec;
  if (duration < 0.8) duration = 0.8;
  if (duration > 4) duration = 4;
  var length = Math.max(1, Math.floor(duration * sampleRate));
  var seed = (Math.round(duration * 1000) * 1000 + Math.round(snow * 1000)) >>> 0;
  var random = createRandom(seed);
  var left = new Float32Array(length);
  var right = new Float32Array(length);
  var bodyDecay = duration * 0.3;
  var brightDecay = duration * (0.045 + (1 - snow) * 0.16);
  var mildCutoff = lerp(7600, 2000, snow);
  var bodyState = 0;
  var brightState = 0;

  for (var sampleIndex = 0; sampleIndex < length; sampleIndex++) {
    var time = sampleIndex / sampleRate;
    // Keep the first 120ms almost free of wash so the hill slaps stay sparse.
    var fadeIn = time <= 0.12 ? 0 : Math.min(1, (time - 0.12) / 0.18);
    var white = random() * 2 - 1;
    bodyState = bodyState * 0.986 + white * 0.014;
    brightState = brightState * 0.42 + white * 0.58;
    var bodyEnv = Math.exp(-time / bodyDecay);
    var brightEnv = Math.exp(-time / brightDecay);
    left[sampleIndex] = fadeIn * (bodyState * bodyEnv + brightState * brightEnv * 0.48);
  }

  highpassInPlace(left, sampleRate, 240, 0.707);
  lowpassInPlace(left, sampleRate, mildCutoff, 0.707);
  lowpassInPlace(left, sampleRate, mildCutoff, 0.707);
  scaleForConvolution(left, 0.58);

  var shift = Math.round(0.007 * sampleRate);
  for (var shiftIndex = shift; shiftIndex < length; shiftIndex++) {
    right[shiftIndex] = left[shiftIndex - shift] * 0.98;
  }

  var strongCutoff = lerp(6200, 720, Math.pow(snow, 0.85));
  var spikeTimes = [0.036, 0.082, 0.134, 0.192, 0.252];
  var spikeAmps = [1, 0.7, 0.48, 0.34, 0.22];
  var channels = [left, right];
  for (var channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    var spikes = new Float32Array(length);
    var stereoShift = channelIndex === 0 ? -0.007 : 0.01;
    for (var spikeIndex = 0; spikeIndex < spikeTimes.length; spikeIndex++) {
      var jitter = (random() - 0.5) * 0.012;
      var spikeTime = spikeTimes[spikeIndex] + jitter + stereoShift;
      var sign = random() < 0.5 ? -1 : 1;
      var amp = sign * spikeAmps[spikeIndex] * (0.86 + random() * 0.18);
      var spikeAt = Math.floor(spikeTime * sampleRate);
      if (spikeAt > 1 && spikeAt < length - 2) {
        spikes[spikeAt] += amp;
      }
    }
    // Keep the reflection coefficient fixed. Re-peaking after a heavy lowpass
    // would turn snow into a louder, longer thud instead of a duller echo.
    highpassInPlace(spikes, sampleRate, 260, 0.707);
    lowpassInPlace(spikes, sampleRate, strongCutoff, 0.707);
    var channel = channels[channelIndex];
    for (var mixIndex = 0; mixIndex < length; mixIndex++) {
      var mixed = channel[mixIndex] + spikes[mixIndex] * 0.12;
      channel[mixIndex] = Number.isFinite(mixed) ? mixed : 0;
    }
  }

  return {
    sampleRate: sampleRate,
    duration: duration,
    channels: [left, right],
  };
}

function SkiSnowEngine(context, initialParams) {
  this.context = context;
  this.params = Object.assign({}, DEFAULT_PARAMS, initialParams || {});
  this.buffer = null;
  this.source = null;
  this.playing = false;
  this.playOffset = 0;
  this.startedAt = 0;
  this.activeSlot = '';
  this.impulseTimer = 0;
  this.onState = null;
  this.buildGraph();
  this.applyParams(false);
  this.rebuildImpulse();
}

SkiSnowEngine.prototype.buildGraph = function buildGraph() {
  var context = this.context;
  this.input = context.createGain();
  this.input.gain.value = 0.92;

  this.compressor = context.createDynamicsCompressor();
  this.compressor.threshold.value = -18;
  this.compressor.knee.value = 20;
  this.compressor.ratio.value = 1.5;
  this.compressor.attack.value = 0.015;
  this.compressor.release.value = 0.28;

  this.paDry = context.createGain();
  this.paWet = context.createGain();
  this.paHpf = context.createBiquadFilter();
  this.paHpf.type = 'highpass';
  this.paHpf.Q.value = 0.7;
  this.paLpf = context.createBiquadFilter();
  this.paLpf.type = 'lowpass';
  this.paLpf.Q.value = 0.7;
  this.paLpf2 = context.createBiquadFilter();
  this.paLpf2.type = 'lowpass';
  this.paLpf2.Q.value = 0.7;
  this.paPresence = context.createBiquadFilter();
  this.paPresence.type = 'peaking';
  this.paPresence.frequency.value = 1650;
  this.paPresence.Q.value = 0.9;
  this.paPresence.gain.value = 5.5;

  this.preSplit = context.createGain();
  this.dryLpf = context.createBiquadFilter();
  this.dryLpf.type = 'lowpass';
  this.dryLpf.Q.value = 0.5;
  this.dryGain = context.createGain();

  // Explicit mono downmix keeps hill slaps centered before they are panned.
  // A splitter-and-half-gain sum would drop real mono files by 6 dB.
  this.wetMono = context.createGain();
  try {
    this.wetMono.channelCount = 1;
    this.wetMono.channelCountMode = 'explicit';
    this.wetMono.channelInterpretation = 'speakers';
  } catch (error) {
    // Some older engines reject the explicit count; the default upmix still plays.
  }
  this.wetSend = context.createGain();
  this.predelay = context.createDelay(0.2);

  this.taps = [];
  for (var tapIndex = 0; tapIndex < 3; tapIndex++) {
    var delay = context.createDelay(0.5);
    var lpf = context.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.Q.value = 0.7;
    var gain = context.createGain();
    var panner = context.createStereoPanner();
    this.taps.push({ delay: delay, lpf: lpf, gain: gain, panner: panner });
  }

  this.lateHp = context.createBiquadFilter();
  this.lateHp.type = 'highpass';
  this.lateHp.frequency.value = 220;
  this.lateHp.Q.value = 0.7;
  this.latePreLpf = context.createBiquadFilter();
  this.latePreLpf.type = 'lowpass';
  this.latePreLpf.frequency.value = 9000;
  this.latePreLpf.Q.value = 0.5;

  this.convolverA = context.createConvolver();
  this.convolverB = context.createConvolver();
  this.convolverA.normalize = false;
  this.convolverB.normalize = false;
  this.gainA = context.createGain();
  this.gainB = context.createGain();
  this.gainA.gain.value = 0;
  this.gainB.gain.value = 0;

  this.latePostLpf = context.createBiquadFilter();
  this.latePostLpf.type = 'lowpass';
  this.latePostLpf.Q.value = 0.7;
  this.wetGain = context.createGain();

  this.widenSplit = context.createChannelSplitter(2);
  this.widenMerge = context.createChannelMerger(2);
  this.widenDelayL = context.createDelay(0.05);
  this.widenDelayR = context.createDelay(0.05);
  this.widenDelayL.delayTime.value = 0.011;
  this.widenDelayR.delayTime.value = 0.015;
  this.crossL = context.createGain();
  this.crossR = context.createGain();
  this.crossL.gain.value = 0.1;
  this.crossR.gain.value = 0.1;

  this.master = context.createGain();
  this.limiter = context.createDynamicsCompressor();
  this.limiter.threshold.value = -2;
  this.limiter.knee.value = 0;
  this.limiter.ratio.value = 20;
  this.limiter.attack.value = 0.002;
  this.limiter.release.value = 0.1;

  this.input.connect(this.compressor);
  this.compressor.connect(this.paDry);
  this.compressor.connect(this.paHpf);
  this.paHpf.connect(this.paLpf);
  this.paLpf.connect(this.paLpf2);
  this.paLpf2.connect(this.paPresence);
  this.paPresence.connect(this.paWet);
  this.paDry.connect(this.preSplit);
  this.paWet.connect(this.preSplit);

  this.preSplit.connect(this.dryLpf);
  this.dryLpf.connect(this.dryGain);
  this.dryGain.connect(this.master);

  this.preSplit.connect(this.wetMono);
  this.wetMono.connect(this.wetSend);
  this.wetSend.connect(this.predelay);

  for (var connectIndex = 0; connectIndex < this.taps.length; connectIndex++) {
    var tap = this.taps[connectIndex];
    this.predelay.connect(tap.delay);
    tap.delay.connect(tap.lpf);
    tap.lpf.connect(tap.gain);
    tap.gain.connect(tap.panner);
    tap.panner.connect(this.wetGain);
  }

  this.predelay.connect(this.lateHp);
  this.lateHp.connect(this.latePreLpf);
  this.latePreLpf.connect(this.convolverA);
  this.latePreLpf.connect(this.convolverB);
  this.convolverA.connect(this.gainA);
  this.convolverB.connect(this.gainB);
  this.gainA.connect(this.latePostLpf);
  this.gainB.connect(this.latePostLpf);
  this.latePostLpf.connect(this.wetGain);

  this.wetGain.connect(this.widenSplit);
  this.widenSplit.connect(this.widenMerge, 0, 0);
  this.widenSplit.connect(this.widenMerge, 1, 1);
  this.widenSplit.connect(this.widenDelayL, 0);
  this.widenDelayL.connect(this.crossL);
  this.crossL.connect(this.widenMerge, 0, 1);
  this.widenSplit.connect(this.widenDelayR, 1);
  this.widenDelayR.connect(this.crossR);
  this.crossR.connect(this.widenMerge, 0, 0);
  this.widenMerge.connect(this.master);
  this.master.connect(this.limiter);
  this.limiter.connect(context.destination);
};

SkiSnowEngine.prototype.writeParam = function writeEngineParam(param, value, timeConstant) {
  var now = this.context.currentTime;
  param.cancelScheduledValues(now);
  if (!timeConstant) {
    param.setValueAtTime(value, now);
    return;
  }
  param.setValueAtTime(param.value, now);
  param.setTargetAtTime(value, now, timeConstant);
};

SkiSnowEngine.prototype.applyParams = function applyParams(smooth) {
  var mapped = mapSkiParameters(this.params);
  var tau = smooth ? 0.03 : 0;
  var delayTau = smooth ? 0.05 : 0;
  this.writeParam(this.predelay.delayTime, mapped.predelay, delayTau);
  this.writeParam(this.dryLpf.frequency, mapped.dryLowpass, tau);
  this.writeParam(this.dryGain.gain, mapped.dryGain, tau);
  this.writeParam(this.wetSend.gain, mapped.wetSend, tau);
  this.writeParam(this.wetGain.gain, mapped.wetGain, tau);
  this.writeParam(this.paDry.gain, mapped.paDry, tau);
  this.writeParam(this.paWet.gain, mapped.paWet, tau);
  this.writeParam(this.paHpf.frequency, mapped.paHighpass, tau);
  this.writeParam(this.paLpf.frequency, mapped.paLowpass, tau);
  this.writeParam(this.paLpf2.frequency, mapped.paLowpass, tau);
  this.writeParam(this.master.gain, mapped.masterGain, tau);
  this.writeParam(this.latePostLpf.frequency, mapped.lateCutoff, tau);
  for (var tapIndex = 0; tapIndex < this.taps.length; tapIndex++) {
    var tap = this.taps[tapIndex];
    this.writeParam(tap.delay.delayTime, mapped.slapTimes[tapIndex], delayTau);
    this.writeParam(tap.lpf.frequency, mapped.slapCutoff, tau);
    this.writeParam(tap.gain.gain, mapped.slapGains[tapIndex], tau);
    this.writeParam(tap.panner.pan, mapped.slapPans[tapIndex], tau);
  }
};

SkiSnowEngine.prototype.setParams = function setParams(partial) {
  var previousSnow = this.params.snow;
  var previousAir = this.params.air;
  Object.assign(this.params, partial);
  this.applyParams(true);
  var snowChanged = Math.abs(this.params.snow - previousSnow) > 0.0001;
  var airChanged = Math.abs(this.params.air - previousAir) > 0.0001;
  if (snowChanged || airChanged) this.scheduleImpulse();
};

SkiSnowEngine.prototype.scheduleImpulse = function scheduleImpulse() {
  var engine = this;
  if (this.impulseTimer) clearTimeout(this.impulseTimer);
  this.impulseTimer = setTimeout(function () {
    engine.impulseTimer = 0;
    engine.rebuildImpulse();
  }, 80);
};

SkiSnowEngine.prototype.rebuildImpulse = function rebuildImpulse() {
  var mapped = mapSkiParameters(this.params);
  var rendered = renderSkiImpulseResponse(this.context.sampleRate, mapped.irDuration, this.params.snow);
  var buffer = this.context.createBuffer(2, rendered.channels[0].length, rendered.sampleRate);
  buffer.getChannelData(0).set(rendered.channels[0]);
  buffer.getChannelData(1).set(rendered.channels[1]);
  this.crossfadeImpulse(buffer);
};

SkiSnowEngine.prototype.crossfadeImpulse = function crossfadeImpulse(buffer) {
  var now = this.context.currentTime;
  if (!this.activeSlot) {
    this.convolverA.buffer = buffer;
    this.gainA.gain.cancelScheduledValues(now);
    this.gainB.gain.cancelScheduledValues(now);
    this.gainA.gain.setValueAtTime(1, now);
    this.gainB.gain.setValueAtTime(0, now);
    this.activeSlot = 'a';
    return;
  }
  var useB = this.activeSlot === 'a';
  var next = useB ? this.convolverB : this.convolverA;
  var nextGain = useB ? this.gainB : this.gainA;
  var prevGain = useB ? this.gainA : this.gainB;
  next.buffer = buffer;
  var fadeEnd = now + 0.07;
  nextGain.gain.cancelScheduledValues(now);
  prevGain.gain.cancelScheduledValues(now);
  nextGain.gain.setValueAtTime(nextGain.gain.value, now);
  prevGain.gain.setValueAtTime(prevGain.gain.value, now);
  nextGain.gain.linearRampToValueAtTime(1, fadeEnd);
  prevGain.gain.linearRampToValueAtTime(0, fadeEnd);
  this.activeSlot = useB ? 'b' : 'a';
};

SkiSnowEngine.prototype.loadBuffer = function loadBuffer(audioBuffer) {
  this.stopSource(true);
  this.buffer = audioBuffer;
  if (this.onState) this.onState();
};

SkiSnowEngine.prototype.getOffset = function getOffset() {
  if (!this.buffer) return 0;
  if (!this.playing) return this.playOffset;
  var elapsed = this.context.currentTime - this.startedAt;
  return Math.min(this.buffer.duration, this.playOffset + Math.max(0, elapsed));
};

SkiSnowEngine.prototype.stopSource = function stopSource(resetOffset) {
  var previous = this.source;
  this.source = null;
  this.playing = false;
  if (previous) {
    previous.onended = null;
    try {
      previous.stop();
    } catch (error) {
      // The source may already have ended.
    }
    try {
      previous.disconnect();
    } catch (error) {
      // Ignore a node that was already disconnected.
    }
  }
  if (resetOffset) this.playOffset = 0;
};

SkiSnowEngine.prototype.startAtOffset = function startAtOffset() {
  if (!this.buffer) return;
  if (this.playOffset >= this.buffer.duration - 0.02) this.playOffset = 0;
  this.stopSource(false);
  var source = this.context.createBufferSource();
  source.buffer = this.buffer;
  source.connect(this.input);
  var offset = this.playOffset;
  source.start(0, offset);
  this.startedAt = this.context.currentTime;
  this.source = source;
  this.playing = true;
  var engine = this;
  source.onended = function () {
    if (engine.source !== source) return;
    engine.source = null;
    engine.playing = false;
    engine.playOffset = 0;
    if (engine.onState) engine.onState();
  };
  if (this.onState) this.onState();
};

SkiSnowEngine.prototype.play = function play() {
  if (!this.buffer || this.playing) return;
  if (this.playOffset >= this.buffer.duration - 0.02) this.playOffset = 0;
  this.startAtOffset();
};

SkiSnowEngine.prototype.pause = function pause() {
  if (!this.playing) return;
  this.playOffset = this.getOffset();
  this.stopSource(false);
  if (this.onState) this.onState();
};

SkiSnowEngine.prototype.stop = function stop() {
  this.stopSource(true);
  if (this.onState) this.onState();
};

SkiSnowEngine.prototype.seek = function seek(ratio) {
  if (!this.buffer) return;
  var wasPlaying = this.playing;
  this.playOffset = clamp01(ratio) * this.buffer.duration;
  if (wasPlaying) this.startAtOffset();
  else if (this.onState) this.onState();
};

function ridgePath(ctx, width, height, yPoints) {
  ctx.beginPath();
  ctx.moveTo(0, yPoints[0] * height);
  var step = width / (yPoints.length - 1);
  for (var pointIndex = 1; pointIndex < yPoints.length; pointIndex++) {
    var x = step * pointIndex;
    var y = yPoints[pointIndex] * height;
    var previousX = step * (pointIndex - 1);
    var previousY = yPoints[pointIndex - 1] * height;
    var midX = (previousX + x) / 2;
    ctx.bezierCurveTo(midX, previousY, midX, y, x, y);
  }
}

function drawRidge(ctx, width, height, yPoints, fill, stroke) {
  ridgePath(ctx, width, height, yPoints);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ridgePath(ctx, width, height, yPoints);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function drawPine(ctx, x, y, scale) {
  var treeHeight = 54 * scale;
  var half = 14 * scale;
  ctx.fillStyle = '#61788a';
  ctx.beginPath();
  ctx.moveTo(x, y - treeHeight);
  ctx.lineTo(x + half, y);
  ctx.lineTo(x - half, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8aa0ae';
  ctx.beginPath();
  ctx.moveTo(x, y - treeHeight);
  ctx.lineTo(x + half * 0.42, y - treeHeight * 0.46);
  ctx.lineTo(x, y - treeHeight * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.moveTo(x, y - treeHeight - 1);
  ctx.lineTo(x + half * 0.34, y - treeHeight * 0.8);
  ctx.lineTo(x - half * 0.16, y - treeHeight * 0.82);
  ctx.closePath();
  ctx.fill();
}

function drawLodge(ctx, x, y, scale, windowAlpha) {
  var w = 86 * scale;
  var h = 40 * scale;
  ctx.fillStyle = 'rgba(150, 170, 182, 0.28)';
  ctx.beginPath();
  ctx.ellipse(x + 8, y + h * 0.92, w * 0.46, 7 * scale, -0.15, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#8ea3b2';
  ctx.fillRect(x - w * 0.36, y, w * 0.74, h * 0.78);

  ctx.fillStyle = '#f7f9fa';
  ctx.beginPath();
  ctx.moveTo(x - w * 0.52, y + h * 0.08);
  ctx.lineTo(x - w * 0.08, y - h * 0.72);
  ctx.lineTo(x + w * 0.62, y - h * 0.02);
  ctx.lineTo(x + w * 0.42, y + h * 0.16);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(90, 110, 122, 0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = 'rgba(243, 228, 196, ' + windowAlpha + ')';
  ctx.fillRect(x - w * 0.22, y + h * 0.22, w * 0.12, h * 0.26);
  ctx.fillRect(x + w * 0.02, y + h * 0.22, w * 0.12, h * 0.26);
}

function quadPoint(x1, y1, x2, y2, amount) {
  var sag = Math.min(16, Math.hypot(x2 - x1, y2 - y1) * 0.05);
  var cx = (x1 + x2) / 2;
  var cy = (y1 + y2) / 2 + sag;
  var remain = 1 - amount;
  return {
    x: remain * remain * x1 + 2 * remain * amount * cx + amount * amount * x2,
    y: remain * remain * y1 + 2 * remain * amount * cy + amount * amount * y2,
  };
}

function drawLift(ctx, width, height, time, reduceMotion) {
  var towers = [
    { x: 0.12, base: 0.7, top: 0.52 },
    { x: 0.4, base: 0.68, top: 0.44 },
    { x: 0.68, base: 0.62, top: 0.36 },
  ];
  ctx.strokeStyle = '#6a8090';
  ctx.fillStyle = '#6a8090';
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  for (var towerIndex = 0; towerIndex < towers.length; towerIndex++) {
    var tower = towers[towerIndex];
    var x = tower.x * width;
    var baseY = tower.base * height;
    var topY = tower.top * height;
    ctx.beginPath();
    ctx.moveTo(x - 7, baseY);
    ctx.lineTo(x, topY);
    ctx.lineTo(x + 7, baseY);
    ctx.moveTo(x - 4, (baseY + topY) * 0.5);
    ctx.lineTo(x + 4, (baseY + topY) * 0.5);
    ctx.stroke();
  }
  ctx.beginPath();
  var first = towers[0];
  ctx.moveTo(first.x * width, first.top * height);
  for (var segmentIndex = 1; segmentIndex < towers.length; segmentIndex++) {
    var from = towers[segmentIndex - 1];
    var to = towers[segmentIndex];
    var sag = Math.min(16, Math.hypot((to.x - from.x) * width, (to.top - from.top) * height) * 0.05);
    ctx.quadraticCurveTo(
      ((from.x + to.x) / 2) * width,
      ((from.top + to.top) / 2) * height + sag,
      to.x * width,
      to.top * height
    );
  }
  ctx.stroke();

  var travel = reduceMotion ? 0.15 : (time * 0.025) % 1;
  for (var chairIndex = 0; chairIndex < 4; chairIndex++) {
    var along = (travel + chairIndex / 4) % 1;
    var segment = along < 0.5 ? 0 : 1;
    var local = along < 0.5 ? along / 0.5 : (along - 0.5) / 0.5;
    var startTower = towers[segment];
    var endTower = towers[segment + 1];
    var point = quadPoint(
      startTower.x * width,
      startTower.top * height,
      endTower.x * width,
      endTower.top * height,
      local
    );
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x, point.y + 11);
    ctx.stroke();
    ctx.fillRect(point.x - 4, point.y + 11, 8, 5);
  }
}

function drawSkier(ctx, x, y, scale) {
  ctx.strokeStyle = '#3d5160';
  ctx.fillStyle = '#3d5160';
  ctx.lineWidth = 1.3 * scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 7 * scale, y + 2 * scale);
  ctx.lineTo(x + 12 * scale, y - 2 * scale);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 5 * scale, y - 11 * scale);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + 6 * scale, y - 14 * scale, 2.1 * scale, 0, Math.PI * 2);
  ctx.fill();
}

var FLAKE_POOL = 220;
var flakes = [];
for (var flakeIndex = 0; flakeIndex < FLAKE_POOL; flakeIndex++) {
  flakes.push({
    x: Math.random(),
    y: Math.random(),
    size: 0.8 + Math.random() * 1.8,
    speed: 0.06 + Math.random() * 0.14,
    drift: 0.008 + Math.random() * 0.02,
    phase: Math.random() * Math.PI * 2,
    alpha: 0.25 + Math.random() * 0.6,
  });
}

function drawScene(ctx, width, height, frame) {
  var sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#c5d5e2');
  sky.addColorStop(0.42, '#e4edf2');
  sky.addColorStop(1, '#f3f1ec');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  var sunX = width * 0.76;
  var sunY = height * 0.2;
  var sun = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, width * 0.2);
  sun.addColorStop(0, 'rgba(255, 252, 246, 0.95)');
  sun.addColorStop(0.25, 'rgba(255, 248, 236, 0.28)');
  sun.addColorStop(1, 'rgba(255, 248, 236, 0)');
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(sunX, sunY, width * 0.2, 0, Math.PI * 2);
  ctx.fill();

  drawRidge(ctx, width, height, [0.42, 0.4, 0.37, 0.32, 0.35, 0.28, 0.33, 0.36, 0.31, 0.38, 0.4], '#d7e3eb', 'rgba(255,255,255,0.75)');
  drawRidge(ctx, width, height, [0.52, 0.5, 0.47, 0.44, 0.48, 0.41, 0.45, 0.43, 0.48, 0.5, 0.49], '#c3d2dc', 'rgba(255,255,255,0.4)');

  ctx.beginPath();
  ctx.moveTo(0, height * 0.6);
  ctx.bezierCurveTo(width * 0.28, height * 0.55, width * 0.62, height * 0.66, width, height * 0.6);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = '#f5f7f8';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, height * 0.6);
  ctx.bezierCurveTo(width * 0.28, height * 0.55, width * 0.62, height * 0.66, width, height * 0.6);
  ctx.bezierCurveTo(width * 0.62, height * 0.7, width * 0.28, height * 0.64, 0, height * 0.7);
  ctx.closePath();
  ctx.fillStyle = '#e3edf2';
  ctx.fill();

  var distantPines = [
    [0.08, 0.56, 0.7],
    [0.18, 0.52, 0.55],
    [0.86, 0.5, 0.5],
    [0.93, 0.53, 0.62],
  ];
  for (var distantIndex = 0; distantIndex < distantPines.length; distantIndex++) {
    var distant = distantPines[distantIndex];
    drawPine(ctx, distant[0] * width, distant[1] * height, distant[2]);
  }

  drawLift(ctx, width, height, frame.time, frame.reduceMotion);

  var windowAlpha = 0.38 + (frame.playing ? 0.4 : 0.08) * (0.35 + frame.mix);
  drawLodge(ctx, width * 0.8, height * 0.6, Math.max(0.85, width / 900), windowAlpha);

  var foreground = [
    [0.05, 0.64, 1.25],
    [0.09, 0.66, 0.85],
    [0.13, 0.63, 1.05],
    [0.9, 0.64, 1.15],
    [0.95, 0.66, 0.8],
  ];
  for (var pineIndex = 0; pineIndex < foreground.length; pineIndex++) {
    var pine = foreground[pineIndex];
    drawPine(ctx, pine[0] * width, pine[1] * height, pine[2]);
  }

  drawSkier(ctx, width * 0.34, height * 0.74, Math.max(0.9, width / 1000));

  var fogAlpha = 0.035 + frame.air * 0.12;
  for (var bandIndex = 0; bandIndex < 3; bandIndex++) {
    var bandY = height * (0.58 + bandIndex * 0.08) + Math.sin(frame.time * 0.18 + bandIndex) * 8;
    var fog = ctx.createLinearGradient(0, bandY, 0, bandY + 46);
    fog.addColorStop(0, 'rgba(244, 247, 249, 0)');
    fog.addColorStop(0.5, 'rgba(244, 247, 249, ' + fogAlpha + ')');
    fog.addColorStop(1, 'rgba(244, 247, 249, 0)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, bandY, width, 46);
  }

  ctx.fillStyle = 'rgba(236, 242, 245, ' + (0.04 + frame.air * 0.07) + ')';
  ctx.beginPath();
  ctx.ellipse(width * (0.42 + Math.sin(frame.time * 0.1) * 0.03), height * 0.8, width * 0.26, 26, 0, 0, Math.PI * 2);
  ctx.fill();

  var flakeCount = Math.round(64 + frame.snow * 80 + frame.mix * (frame.playing ? 60 : 22));
  if (flakeCount > FLAKE_POOL) flakeCount = FLAKE_POOL;
  var motion = frame.reduceMotion ? 0.08 : 1;
  for (var drawIndex = 0; drawIndex < FLAKE_POOL; drawIndex++) {
    var flake = flakes[drawIndex];
    flake.y += flake.speed * frame.dt * motion;
    flake.x += Math.sin(frame.time * 0.35 + flake.phase) * flake.drift * frame.dt * motion;
    if (flake.y > 1.05) {
      flake.y = -0.05;
      flake.x = Math.random();
    }
    if (flake.x < -0.05) flake.x = 1.05;
    if (flake.x > 1.05) flake.x = -0.05;
    if (drawIndex >= flakeCount) continue;
    ctx.fillStyle = 'rgba(255,255,255,' + flake.alpha + ')';
    ctx.beginPath();
    ctx.arc(flake.x * width, flake.y * height, flake.size, 0, Math.PI * 2);
    ctx.fill();
  }

  var wash = frame.mix * 0.035 + (frame.playing ? frame.mix * 0.05 : 0);
  if (wash > 0) {
    ctx.fillStyle = 'rgba(255,255,255,' + wash + ')';
    ctx.fillRect(0, 0, width, height);
  }

  var vignette = ctx.createRadialGradient(width * 0.5, height * 0.45, width * 0.2, width * 0.5, height * 0.5, width * 0.72);
  vignette.addColorStop(0, 'rgba(70, 90, 105, 0)');
  vignette.addColorStop(1, 'rgba(70, 90, 105, 0.16)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

function fitCanvas(canvas) {
  var rect = canvas.getBoundingClientRect();
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var width = Math.max(1, Math.round(rect.width));
  var height = Math.max(1, Math.round(rect.height));
  var pixelWidth = Math.round(width * dpr);
  var pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: ctx, width: width, height: height };
}

function computePeaks(audioBuffer, columnCount) {
  var channelCount = audioBuffer.numberOfChannels;
  var channels = [];
  for (var channelIndex = 0; channelIndex < channelCount; channelIndex++) {
    channels.push(audioBuffer.getChannelData(channelIndex));
  }
  var length = audioBuffer.length;
  var samplesPerColumn = Math.max(1, Math.floor(length / columnCount));
  var stride = Math.max(1, Math.floor(samplesPerColumn / 360));
  var peaks = new Array(columnCount);
  for (var columnIndex = 0; columnIndex < columnCount; columnIndex++) {
    var start = columnIndex * samplesPerColumn;
    var end = Math.min(length, start + samplesPerColumn);
    var min = 0;
    var max = 0;
    for (var sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
      var sample = 0;
      for (var mixChannel = 0; mixChannel < channelCount; mixChannel++) {
        sample += channels[mixChannel][sampleIndex];
      }
      sample /= channelCount;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    peaks[columnIndex] = { min: min, max: max };
  }
  return peaks;
}

function drawWaveform(ctx, width, height, peaks, progress) {
  ctx.clearRect(0, 0, width, height);
  if (!peaks) {
    ctx.strokeStyle = 'rgba(61, 85, 102, 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    return;
  }
  var mid = height / 2;
  var columnWidth = width / peaks.length;
  var playedColumns = Math.floor(progress * peaks.length);
  ctx.fillStyle = 'rgba(61, 85, 102, 0.06)';
  ctx.fillRect(0, 0, width * progress, height);
  for (var columnIndex = 0; columnIndex < peaks.length; columnIndex++) {
    var peak = peaks[columnIndex];
    var top = mid + peak.min * (mid - 3);
    var bottom = mid + peak.max * (mid - 3);
    ctx.fillStyle = columnIndex <= playedColumns ? '#2c4150' : '#b7c6d0';
    ctx.fillRect(columnIndex * columnWidth, top, Math.max(1, columnWidth - 0.5), Math.max(1, bottom - top));
  }
  ctx.fillStyle = '#2c4150';
  ctx.fillRect(Math.max(0, progress * width - 0.5), 6, 1.5, height - 12);
}

function boot() {
  var params = Object.assign({}, DEFAULT_PARAMS);
  var engine = null;
  var peaks = null;
  var loadedName = '';
  var lastPercent = -1;
  var lastClock = '';
  var sceneTime = 0;
  var lastFrame = performance.now();
  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reduceMotion = motionQuery.matches;

  var stage = document.getElementById('stage');
  var sceneCanvas = document.getElementById('scene');
  var waveCanvas = document.getElementById('waveform');
  var waveWrap = document.getElementById('waveWrap');
  var waveEmpty = document.getElementById('waveEmpty');
  var stageHint = document.getElementById('stageHint');
  var playButton = document.getElementById('play');
  var pauseButton = document.getElementById('pause');
  var stopButton = document.getElementById('stop');
  var openButton = document.getElementById('openFile');
  var fileInput = document.getElementById('file');
  var fileName = document.getElementById('fileName');
  var timeLabel = document.getElementById('time');
  var statusLabel = document.getElementById('status');
  var knobRoot = document.getElementById('knobs');
  var knobElements = {};

  function setStatus(message) {
    statusLabel.textContent = message || '';
  }

  function renderKnob(id) {
    var knob = knobElements[id];
    if (!knob) return;
    var value = params[id];
    knob.style.setProperty('--p', String(value));
    knob.querySelector('.knob-value').textContent = String(Math.round(value * 100));
    knob.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  }

  function setKnob(id, value) {
    params[id] = clamp01(value);
    renderKnob(id);
    if (engine) engine.setParams((function () {
      var partial = {};
      partial[id] = params[id];
      return partial;
    })());
  }

  for (var specIndex = 0; specIndex < KNOB_SPECS.length; specIndex++) {
    (function (spec) {
      var knob = document.createElement('div');
      knob.className = 'knob';
      knob.tabIndex = 0;
      knob.setAttribute('role', 'slider');
      knob.setAttribute('aria-label', spec.label);
      knob.setAttribute('aria-valuemin', '0');
      knob.setAttribute('aria-valuemax', '100');
      knob.innerHTML = ''
        + '<div class="knob-face">'
        + '<div class="knob-ring"></div>'
        + '<div class="knob-cap"><span class="knob-needle"></span></div>'
        + '</div>'
        + '<span class="knob-name"></span>'
        + '<span class="knob-value"></span>'
        + '<span class="knob-hint"></span>';
      knob.querySelector('.knob-name').textContent = spec.name;
      knob.querySelector('.knob-hint').textContent = spec.hint;
      knobElements[spec.id] = knob;
      knobRoot.appendChild(knob);
      renderKnob(spec.id);

      var drag = null;
      knob.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        knob.focus();
        drag = { y: event.clientY, value: params[spec.id], pointerId: event.pointerId };
        try {
          knob.setPointerCapture(event.pointerId);
        } catch (error) {
          // A synthetic pointer has no active id; the drag state still tracks the move.
        }
      });
      knob.addEventListener('pointermove', function (event) {
        if (!drag || drag.pointerId !== event.pointerId) return;
        var span = event.shiftKey ? 320 : 150;
        setKnob(spec.id, drag.value + (drag.y - event.clientY) / span);
      });
      knob.addEventListener('pointerup', function () { drag = null; });
      knob.addEventListener('pointercancel', function () { drag = null; });
      knob.addEventListener('dblclick', function () { setKnob(spec.id, DEFAULT_PARAMS[spec.id]); });
      knob.addEventListener('wheel', function (event) {
        event.preventDefault();
        var step = event.shiftKey ? 0.01 : 0.03;
        var direction = event.deltaY < 0 ? 1 : -1;
        setKnob(spec.id, params[spec.id] + direction * step);
      }, { passive: false });
      knob.addEventListener('keydown', function (event) {
        var step = event.shiftKey ? 0.05 : 0.01;
        var next = params[spec.id];
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next += step;
        else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next -= step;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = 1;
        else if (event.key === 'PageUp') next += 0.1;
        else if (event.key === 'PageDown') next -= 0.1;
        else return;
        event.preventDefault();
        setKnob(spec.id, next);
      });
    })(KNOB_SPECS[specIndex]);
  }

  function syncTransport() {
    var hasFile = Boolean(engine && engine.buffer);
    var playing = Boolean(engine && engine.playing);
    playButton.disabled = !hasFile || playing;
    pauseButton.disabled = !playing;
    pauseButton.classList.toggle('active', playing);
    var offset = engine ? engine.getOffset() : 0;
    stopButton.disabled = !hasFile || (!playing && offset <= 0.001);
    waveEmpty.hidden = hasFile;
    stageHint.hidden = hasFile;
    waveWrap.classList.toggle('is-ready', hasFile);
    waveCanvas.setAttribute('aria-disabled', hasFile ? 'false' : 'true');
    fileName.textContent = loadedName || 'No file loaded';
  }

  function ensureEngine() {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      setStatus('This browser has no Web Audio support.');
      return null;
    }
    if (!engine) {
      var context = new AudioContextClass();
      var resumePromise = context.resume();
      engine = new SkiSnowEngine(context, Object.assign({}, params));
      engine.onState = syncTransport;
      window.ski = engine;
      resumePromise.catch(function () {
        setStatus('The audio engine could not start. Try Play again.');
      });
    } else if (engine.context.state !== 'running') {
      engine.context.resume().catch(function () {
        setStatus('The audio engine could not start. Try Play again.');
      });
    }
    return engine;
  }

  function looksLikeAudio(file) {
    if (!file) return false;
    if (!file.type) return true;
    if (file.type.indexOf('audio') === 0) return true;
    return /\.(mp3|wav|wave|ogg|m4a|aac|flac|aiff|aif|webm|caf)$/i.test(file.name);
  }

  function loadFile(file) {
    if (!looksLikeAudio(file)) {
      setStatus('Choose an audio file.');
      return;
    }
    var active = ensureEngine();
    if (!active) return;
    setStatus('Decoding audio…');
    file.arrayBuffer().then(function (bytes) {
      return active.context.decodeAudioData(bytes);
    }).then(function (audioBuffer) {
      peaks = computePeaks(audioBuffer, 960);
      loadedName = file.name;
      active.loadBuffer(audioBuffer);
      setStatus('');
      syncTransport();
    }).catch(function () {
      setStatus('This browser could not decode that file.');
      syncTransport();
    });
  }

  function playFromGesture() {
    var active = ensureEngine();
    if (!active) return;
    if (!active.buffer) {
      setStatus('Open an audio file first.');
      return;
    }
    setStatus('');
    active.play();
  }

  playButton.addEventListener('click', playFromGesture);
  pauseButton.addEventListener('click', function () {
    if (engine) engine.pause();
  });
  stopButton.addEventListener('click', function () {
    if (engine) engine.stop();
  });
  openButton.addEventListener('click', function () {
    fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) loadFile(file);
  });

  var dragDepth = 0;
  window.addEventListener('dragenter', function (event) {
    event.preventDefault();
    dragDepth += 1;
    stage.classList.add('dragover');
  });
  window.addEventListener('dragover', function (event) {
    event.preventDefault();
  });
  window.addEventListener('dragleave', function () {
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      stage.classList.remove('dragover');
    }
  });
  window.addEventListener('drop', function (event) {
    event.preventDefault();
    dragDepth = 0;
    stage.classList.remove('dragover');
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  function seekFromClientX(clientX) {
    if (!engine || !engine.buffer) return;
    var rect = waveCanvas.getBoundingClientRect();
    var ratio = clamp01((clientX - rect.left) / rect.width);
    engine.seek(ratio);
  }

  waveCanvas.addEventListener('pointerdown', function (event) {
    if (!engine || !engine.buffer) return;
    waveCanvas.setPointerCapture(event.pointerId);
    seekFromClientX(event.clientX);
  });
  waveCanvas.addEventListener('pointermove', function (event) {
    if (!waveCanvas.hasPointerCapture(event.pointerId)) return;
    seekFromClientX(event.clientX);
  });
  waveCanvas.addEventListener('keydown', function (event) {
    if (!engine || !engine.buffer) return;
    var duration = engine.buffer.duration;
    var offset = engine.getOffset();
    if (event.key === 'ArrowRight') offset += event.shiftKey ? 5 : 1;
    else if (event.key === 'ArrowLeft') offset -= event.shiftKey ? 5 : 1;
    else if (event.key === 'Home') offset = 0;
    else if (event.key === 'End') offset = duration;
    else return;
    event.preventDefault();
    engine.seek(offset / duration);
  });

  window.addEventListener('keydown', function (event) {
    if (event.code !== 'Space') return;
    var target = event.target;
    if (target && (target.closest('button') || target.closest('.knob'))) return;
    event.preventDefault();
    if (engine && engine.playing) engine.pause();
    else playFromGesture();
  });

  if (motionQuery.addEventListener) {
    motionQuery.addEventListener('change', function () {
      reduceMotion = motionQuery.matches;
    });
  }

  function frame(now) {
    var dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    sceneTime += dt;
    var scene = fitCanvas(sceneCanvas);
    drawScene(scene.ctx, scene.width, scene.height, {
      time: sceneTime,
      dt: dt,
      snow: params.snow,
      air: params.air,
      mix: params.mix,
      playing: Boolean(engine && engine.playing),
      reduceMotion: reduceMotion,
    });

    var progress = 0;
    if (engine && engine.buffer && engine.buffer.duration > 0) {
      progress = engine.getOffset() / engine.buffer.duration;
      var clock = formatClock(engine.getOffset()) + ' / ' + formatClock(engine.buffer.duration);
      if (clock !== lastClock) {
        timeLabel.textContent = clock;
        lastClock = clock;
      }
      var percent = Math.round(progress * 100);
      if (percent !== lastPercent) {
        waveCanvas.setAttribute('aria-valuenow', String(percent));
        lastPercent = percent;
      }
    }
    var wave = fitCanvas(waveCanvas);
    drawWaveform(wave.ctx, wave.width, wave.height, peaks, progress);
    window.requestAnimationFrame(frame);
  }

  syncTransport();
  window.requestAnimationFrame(frame);
}

globalThis.skiDsp = {
  DEFAULT_PARAMS: DEFAULT_PARAMS,
  mapSkiParameters: mapSkiParameters,
  renderSkiImpulseResponse: renderSkiImpulseResponse,
  SkiSnowEngine: SkiSnowEngine,
};

if (typeof document !== 'undefined') {
  boot();
}

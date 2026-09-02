/*
 * Ambient scenes.
 *
 * Each scene is a ten-second render of one place going from morning to night.
 * The video carries the light — sky colour, the sun itself, a shadow crossing a
 * wall, city windows coming on — and nothing here reproduces any of it. The one
 * job is to hold the video on the frame that matches the time of day.
 *
 * Loaded as a plain script by both windows, so it defines a global rather than
 * exporting: the pill and the stats window are separate documents with no
 * bundler between them.
 */
(function () {
  'use strict';

  /*
   * `at` maps a solar event to a timestamp in that render, read off the footage
   * frame by frame. The renders do not pace the day evenly and no two agree —
   * the city is through its sunset by 4.4s while the room is still bright at
   * 7.1s — so every scene carries its own reading. A single shared mapping
   * would put the city in full night while the forest was still lit.
   */
  const SCENES = [
    { id: 'lake',   name: 'Lake',   at: { dawn: 0.15, noon: 2.9, sunset: 4.6, dusk: 6.4, night: 9.6 } },
    { id: 'city',   name: 'City',   at: { dawn: 0.10, noon: 2.6, sunset: 4.4, dusk: 6.2, night: 9.6 } },
    { id: 'forest', name: 'Forest', at: { dawn: 0.20, noon: 3.6, sunset: 6.6, dusk: 8.2, night: 9.8 } },
    { id: 'sea',    name: 'Sea',    at: { dawn: 0.10, noon: 2.9, sunset: 5.5, dusk: 7.1, night: 9.6 } },
    { id: 'room',   name: 'Room',   at: { dawn: 0.10, noon: 2.9, sunset: 7.1, dusk: 8.6, night: 9.9 } },
    { id: 'nordic', name: 'Fjord',  at: { dawn: 0.50, noon: 3.2, sunset: 5.4, dusk: 7.0, night: 9.6 } },
  ];

  const DEFAULT_ID = 'lake';
  const byId = id => SCENES.find(s => s.id === id) || SCENES.find(s => s.id === DEFAULT_ID);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* "19:25" -> 19.4167. Anything unparseable returns null so the caller can
     fall back rather than computing with NaN. */
  function hoursOf(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    if (!m) return null;
    return Number(m[1]) + Number(m[2]) / 60;
  }

  /*
   * Sunrise and sunset come from the prayer timings the app already fetches for
   * the user's exact coordinates — real figures for their location, not a
   * latitude guessed in the renderer. Sunset is Maghrib by definition.
   *
   * The fallback is only for a first run before any timings have arrived.
   */
  function solarFrom(timings) {
    const sunrise = hoursOf(timings && timings.Sunrise);
    const sunset = hoursOf(timings && (timings.Maghrib || timings.Sunset));
    if (sunrise == null || sunset == null || sunset <= sunrise) {
      return { sunrise: 6.5, noon: 13, sunset: 19.5, estimated: true };
    }
    return { sunrise, noon: (sunrise + sunset) / 2, sunset, estimated: false };
  }

  /*
   * Time of day -> a timestamp in this scene's render.
   *
   * Anchored to real solar events, so the mapping slides with the season: in
   * December sunset is at 16:31 and the render reaches its sunset frame then
   * too, rather than at a fixed clock hour.
   *
   * The one trick is dawn. Every render runs one way, morning to night, so a
   * day-long cycle has to close the loop somewhere. Rather than cut from the
   * last frame back to the first, the hour before sunrise scrubs *backwards*
   * through the render. A sunset run in reverse reads convincingly as a
   * sunrise — dark, a band of red on the horizon, then gold, then full light —
   * so the day joins up with no visible seam.
   */
  function videoTime(hour, scene, S) {
    const a = scene.at;
    const stops = [
      [S.sunrise - 1.3, a.night],
      [S.sunrise,       a.dawn],
      [S.noon,          a.noon],
      [S.sunset,        a.sunset],
      [S.sunset + 1.1,  a.dusk],
      [S.sunset + 3.4,  a.night],
    ];
    if (hour <= stops[0][0] || hour >= stops[stops.length - 1][0]) return a.night;
    let i = 0;
    while (i < stops.length - 2 && stops[i + 1][0] < hour) i++;
    const [h0, t0] = stops[i];
    const [h1, t1] = stops[i + 1];
    let t = (hour - h0) / (h1 - h0);
    t = t * t * (3 - 2 * t);                       // ease through every anchor
    return lerp(t0, t1, t);
  }

  const nowHours = () => {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  };

  /*
   * Drives one <video>. It is never played — only seeked — because at real
   * time the render advances about one frame every five minutes, and asking a
   * decoder to play at 1/500th speed is worse than telling it where to be.
   */
  function attach(video, opts) {
    const state = { scene: byId((opts && opts.sceneId) || DEFAULT_ID), solar: solarFrom(opts && opts.timings), want: null };

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');

    function seek(t) {
      if (!video.duration) { state.want = t; return; }   // metadata not in yet
      state.want = null;
      const c = clamp(t, 0, video.duration - 0.04);
      if (Math.abs(video.currentTime - c) > 0.015) video.currentTime = c;
    }

    video.addEventListener('loadedmetadata', () => {
      if (state.want != null) seek(state.want);
    });

    function apply() {
      seek(videoTime(nowHours(), state.scene, state.solar));
    }

    function setScene(id) {
      const next = byId(id);
      if (next.id === state.scene.id && video.getAttribute('src')) return;
      state.scene = next;
      video.src = 'scenes/' + next.id + '.mp4';
      apply();
    }

    setScene(state.scene.id);
    // Once a minute is far more often than the picture changes, and costs a
    // 9ms seek that usually turns out to be a no-op.
    const timer = setInterval(apply, 60000);

    return {
      setScene,
      setTimings(timings) { state.solar = solarFrom(timings); apply(); },
      refresh: apply,
      stop() { clearInterval(timer); },
      get sceneId() { return state.scene.id; },
    };
  }

  window.Scene = { SCENES, DEFAULT_ID, attach, videoTime, solarFrom, byId };
})();

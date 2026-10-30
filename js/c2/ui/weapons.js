/* Tab - Weapons: the game's numbers of every weapon in the demo (the weapon files, maps3d/_hud/hud.json "stats",
 * hud_export.py) with how this demo used them, and a check of the damage model against zPAM's damage log.
 * Damage (Bullet_Fire_Extended of the 1.3 client): `damage` up to maxDamageRange, then linear down to minDamage at
 * minDamageRange (distance from the shooter's eye to the hit), times the hit location's loc* multiplier of the
 * weapon file; a rifle bullet through a player goes on at half damage. 1 m ≈ 39.37 units (the game's inches). */
(function (C2) {
  'use strict';
  const { el, clear, na, sortableTable, approx } = C2.ui;
  const W = C2.weapons;
  const M_PER_UNIT = 0.0254;
  const LOC = { head: 'locHead', helmet: 'locHelmet', neck: 'locNeck', torso_upper: 'locTorsoUpper', torso_lower: 'locTorsoLower',
    right_arm_upper: 'locRightArmUpper', right_arm_lower: 'locRightArmLower', right_hand: 'locRightHand', left_arm_upper: 'locLeftArmUpper',
    left_arm_lower: 'locLeftArmLower', left_hand: 'locLeftHand', right_leg_upper: 'locRightLegUpper', right_leg_lower: 'locRightLegLower',
    right_foot: 'locRightFoot', left_leg_upper: 'locLeftLegUpper', left_leg_lower: 'locLeftLegLower', left_foot: 'locLeftFoot', none: 'locNone' };

  let hudPromise = null;
  /** hud.json (the weapon files' numbers), once */
  C2.loadHudData = () => (hudPromise = hudPromise || fetch('maps3d/_hud/hud.json').then(r => (r.ok ? r.json() : null)).catch(() => null));

  /** the damage of weapon stats st at distance dist (units) to hit location loc (Bullet_Fire_Extended) */
  function damageAt(st, dist, loc) {
    let dmg = st.damage;
    if (dist > st.maxDamageRange) {
      const span = st.minDamageRange - st.maxDamageRange;
      dmg = dist >= st.minDamageRange || span <= 0 ? st.minDamage : Math.trunc(st.damage * (1 - (dist - st.maxDamageRange) / span) + st.minDamage * ((dist - st.maxDamageRange) / span));
    }
    const k = LOC[loc];
    return Math.trunc(dmg * (k && st[k] != null ? st[k] : 1));
  }
  C2.weaponDamageAt = damageAt;

  const m = u => (u * M_PER_UNIT).toFixed(0) + ' m';
  const sec = s => (s == null ? '' : s.toFixed(2).replace(/0$/, '') + ' s');

  function render(root, app) {
    const d = app.data;
    clear(root);
    const box = el('div', { class: 'muted' }, 'Loading the weapon files …');
    root.append(box);
    C2.loadHudData().then(h => {
      clear(root);
      if (!h || !h.weapons) { root.append(el('div', { class: 'empty' }, 'The weapon data (maps3d/_hud/hud.json) is not available.')); return; }
      fill(root, app, d, h);
    });
  }

  function fill(root, app, d, h) {
    // the weapons of the demo: held by a player or named by a kill
    const used = new Map();
    const touch = n => { if (n && n !== 'none' && h.weapons[n] && !used.has(n)) used.set(n, { name: n, kills: 0, hs: 0, dist: 0, nDist: 0, holders: new Set() }); return used.get(n); };
    // a weapon index at time t -> its name (the weapon list of config string 7 then, as Match.weaponName)
    const nameOf = (i, t) => { let list = null; for (const w of d.weaponLists || []) { if (w.t <= t) list = w.list; else break; } return i && list && i <= list.length ? list[i - 1] : null; };
    for (const [cl, P] of Object.entries(d.positions)) {
      const seen = new Set(P.weapon);
      for (const wi of seen) { const n = nameOf(wi, P.t[P.t.length - 1]); const u = touch(n); if (u && +cl < 64) u.holders.add(+cl); }
    }
    for (const k of d.kills) {
      if (!C2.build.kdRule(k).credit || k.phase !== 'live') continue;
      const n = W.killWeapon(k), u = touch(n);
      if (!u) continue;
      u.kills++;
      if (k.headshot) u.hs++;
      if (k.distance != null) { u.dist += k.distance; u.nDist++; }
    }
    const zi = d.zpamInfo || {};
    const usedBy = n => { const v = zi['ui_weapons_usedby_' + n]; return v ? C2.text.stripColors(v.value).split('|').map(s => s.trim()).filter(Boolean).join(', ') : ''; };
    const rows = [...used.values()].map(u => Object.assign(u, { w: h.weapons[u.name], st: h.weapons[u.name].stats || {} }));
    const isGun = r => r.st.damage > 0 && !(r.w.offhandClass > 0);
    const columns = [
      { key: 'weapon', label: 'Weapon', cls: 'col-player', sort: r => W.label(r.name),
        render: r => { const ic = W.weaponIcon(r.name); return [ic ? C2.ui.iconNode(ic, W.label(r.name)) : null, ' ', W.label(r.name)]; } },
      { key: 'damage', label: 'Damage', title: 'damage of a hit at full / at long range (the weapon file: damage, minDamage)', sort: r => r.st.damage || 0,
        render: r => (!isGun(r) ? (r.st.explosionInnerDamage ? r.st.explosionInnerDamage + '→' + r.st.explosionOuterDamage : '') : r.st.minDamage !== r.st.damage ? r.st.damage + '→' + r.st.minDamage : String(r.st.damage)) },
      { key: 'range', label: 'Falloff', title: 'full damage up to maxDamageRange, minDamage from minDamageRange on (metres; 1 m ≈ 39 units). Grenades: the explosion radius', sort: r => r.st.maxDamageRange || r.st.explosionRadius || 0,
        render: r => (!isGun(r) ? (r.st.explosionRadius ? 'radius ' + m(r.st.explosionRadius) : '') : r.st.minDamage === r.st.damage ? 'none' : m(r.st.maxDamageRange) + '–' + m(r.st.minDamageRange)) },
      { key: 'head', label: 'Head ×', title: 'hit-location multipliers of the weapon file: head', sort: r => r.st.locHead || 0, render: r => (isGun(r) ? String(r.st.locHead) : '') },
      { key: 'torso', label: 'Torso ×', title: 'upper / lower torso', sort: r => r.st.locTorsoUpper || 0, render: r => (isGun(r) ? r.st.locTorsoUpper + ' / ' + r.st.locTorsoLower : '') },
      { key: 'limbs', label: 'Arm / leg ×', title: 'upper arm / upper leg', sort: r => r.st.locRightArmUpper || 0, render: r => (isGun(r) ? r.st.locRightArmUpper + ' / ' + r.st.locRightLegUpper : '') },
      { key: 'btk', label: 'Hits to kill', title: 'hits to kill a player at full health (100) at close range: head / upper torso / leg', sort: r => (isGun(r) ? Math.ceil(100 / (r.st.damage * r.st.locTorsoUpper)) : 99),
        render: r => (isGun(r) ? [r.st.locHead, r.st.locTorsoUpper, r.st.locRightLegUpper].map(k => Math.ceil(100 / Math.max(1, Math.trunc(r.st.damage * k)))).join(' / ') : '') },
      { key: 'rpm', label: 'RPM', title: 'rounds per minute: 60 / fireTime', sort: r => (r.st.fireTime ? 60 / r.st.fireTime : 0), render: r => (isGun(r) && r.st.fireTime ? String(Math.round(60 / r.st.fireTime)) : '') },
      { key: 'clip', label: 'Clip / ammo', sort: r => r.st.clipSize || 0, render: r => (r.st.clipSize ? r.st.clipSize + ' / ' + r.st.maxAmmo : '') },
      { key: 'reload', label: 'Reload', title: 'reloadTime (empty: reloadEmptyTime)', sort: r => r.st.reloadTime || 0, render: r => (isGun(r) ? sec(r.st.reloadTime) + (r.st.reloadEmptyTime && r.st.reloadEmptyTime !== r.st.reloadTime ? ' / ' + sec(r.st.reloadEmptyTime) : '') : '') },
      { key: 'ads', label: 'ADS', title: 'aiming down the sights: adsTransInTime (zoom fov)', sort: r => r.st.adsTransInTime || 0, render: r => (isGun(r) && r.st.adsTransInTime ? sec(r.st.adsTransInTime) + (r.st.adsZoomFov ? ' (' + r.st.adsZoomFov + '°)' : '') : '') },
      { key: 'speed', label: 'Speed', title: 'movement speed while holding it (moveSpeedScale)', sort: r => r.st.moveSpeedScale || 0, render: r => (r.st.moveSpeedScale != null ? Math.round(r.st.moveSpeedScale * 100) + ' %' : '') },
      { key: 'kills', label: 'Kills', title: 'kills with it in this demo (match rounds, the kill feed)', sort: r => r.kills, render: r => String(r.kills) },
      { key: 'hs', label: 'HS %', sort: r => (r.kills ? r.hs / r.kills : -1), render: r => (r.kills ? Math.round(100 * r.hs / r.kills) + ' %' : '') },
      { key: 'dist', label: 'Avg kill', title: 'average distance of its kills', sort: r => (r.nDist ? r.dist / r.nDist : -1), render: r => (r.nDist ? m(r.dist / r.nDist) : '') },
      { key: 'used', label: 'Used by', title: "players seen holding it; with zPAM's weapon limits the players zPAM lists for it (ui_weapons_usedby)", sort: r => r.holders.size,
        render: r => { const z = usedBy(r.name); return z ? [z, approx("zPAM's list (the recorder's team) - the server's weapon-limit bookkeeping")] : String(r.holders.size); } }
    ];
    for (const c of columns) if (!c.cls) { c.cls = 'col-stat'; c.num = true; }
    const groups = [
      { label: 'Guns', cls: 'a', rows: rows.filter(isGun).sort((a, b) => b.kills - a.kills) },
      { label: 'Grenades and other', cls: 'b', rows: rows.filter(r => !isGun(r)) }
    ].filter(g => g.rows.length);
    root.append(el('p', { class: 'note' }, 'The numbers of the weapon files (CoD2 1.3) for every weapon of this demo. A hit does the full damage up to the first range, then less down to the minimum at the second; times the hit location (Bullet_Fire_Extended).'),
      sortableTable(columns, groups, { sortKey: 'kills', asc: false, cls: 'scoreboard weapons-table' }));
    // the damage model against zPAM's log: the predicted damage of every logged rifle / sniper hit
    const hits = (d.zpamHits || []).filter(x => h.weapons[x.weapon] && x.my && x.hit && !/shotgun|grenade/.test(x.weapon));
    if (hits.length) {
      let ok = 0;
      const off = [];
      for (const x of hits) {
        const st = h.weapons[x.weapon].stats;
        const dist = Math.hypot(x.hit[0] - x.my[0], x.hit[1] - x.my[1], x.hit[2] - (x.my[2] + 60));
        const p = damageAt(st, dist, x.hitLoc);
        if (Math.abs(p - x.damage) <= 1) ok++; else off.push(W.label(x.weapon) + ' ' + x.hitLoc + ': ' + p + ' predicted, ' + x.damage + ' logged');
      }
      root.append(el('p', { class: 'note', title: off.slice(0, 12).join('\n') || null },
        "Damage model check against zPAM's damage log of the recording player: " + ok + ' of ' + hits.length + ' rifle / sniper / pistol / SMG hits do exactly the damage the weapon files predict for their distance and hit location' +
        (off.length ? "; the others (hover) are zPAM's own changes - it raises bolt-action limb hits to 100 - or a bullet that went through a player first (half damage)" : '') + '.'));
    }
  }

  C2.tabs.weapons = { render, damageAt };
})(window.C2);

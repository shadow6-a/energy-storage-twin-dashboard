/* ============================================================
   三级孪生场景构建：区域地图 → 站内舱体 → 舱内电池簇
   ============================================================ */
(function (global) {
  'use strict';

  const COL = {
    charge: '#3fb6c9',
    discharge: '#dfab52',
    standby: '#3ea87b',
    alert: '#e0523f',
    offline: '#6c7d8c',
    steel: '#24404f',
    steel2: '#1e3543',
    steel3: '#2b4a5b',
    building: '#22394e',
    pcs: '#2a3d4d',
    warn: '#8a5b32'
  };

  function pinColor(st) {
    if (st.comm === 'offline') return COL.offline;
    if (st.hasCrit) return COL.alert;
    if (st.status === 'charging') return COL.charge;
    if (st.status === 'discharging') return COL.discharge;
    return COL.standby;
  }

  const HUB = { x: -30, z: 250 };

  const REGION_PTS = [
    { x: -450, z: -235 }, { x: -300, z: -310 }, { x: -40, z: -318 },
    { x: 250, z: -300 }, { x: 452, z: -205 }, { x: 486, z: 20 },
    { x: 420, z: 200 }, { x: 220, z: 300 }, { x: -40, z: 322 },
    { x: -270, z: 288 }, { x: -448, z: 150 }, { x: -486, z: -60 }
  ];

  /* ---------------- 区域地图 ---------------- */
  function map(stations, opts) {
    opts = opts || {};
    const objects = [];
    const links = [];

    // 地形装饰：水系 / 主干道（低对比，弱化存在感）
    links.push({ from:{x:-560,z:-255}, to:{x:-300,z:-292}, solid:true, color:'rgba(56,104,136,.16)', width:7, y:0.2 });
    links.push({ from:{x:-300,z:-292}, to:{x:60,z:-320}, solid:true, color:'rgba(56,104,136,.16)', width:7, y:0.2 });
    links.push({ from:{x:60,z:-320}, to:{x:430,z:-268}, solid:true, color:'rgba(56,104,136,.16)', width:7, y:0.2 });

    // 汇集点
    /* v1.2.2：骨干线（站→汇集点）此前 0.26 透明度在深色底上几乎不可见，拓扑读起来像散点图；
       提升到 0.42 + 加宽一档，让「同一网架汇聚」的集群叙事成立 */
    links.push({ from:{x:-470,z:60}, to:{x:-120,z:20}, solid:true, color:'rgba(126,163,196,.18)', width:2, y:0.2 });
    links.push({ from:{x:-120,z:20}, to:{x:180,z:60}, solid:true, color:'rgba(126,163,196,.18)', width:2, y:0.2 });
    links.push({ from:{x:180,z:60}, to:{x:470,z:120}, solid:true, color:'rgba(126,163,196,.18)', width:2, y:0.2 });

    objects.push({
      kind:'pin', id:'HUB', pos:{ x:HUB.x, y:0, z:HUB.z }, headY:52, radius:22,
      color:'#5e8fbb', label:'区域并网汇集点',
      labelSub: opts.hubSub || '220kV · 汇集 8 站',
      labelColor:'#c5dcec', subColor:'#8fb3cd'
    });

    stations.forEach((st, i) => {
      const col = pinColor(st);
      const p = (st.power >= 0 ? '+' : '') + st.power.toFixed(1) + ' MW';
      objects.push({
        kind:'pin', id: st.id, pos:{ x:st.x, y:0, z:st.z },
        headY: 58, radius: 24,
        color: col,
        offline: st.comm === 'offline',
        pulse: !!st.hasCrit && opts.showAlerts !== false,
        phase: i * 0.17,
        badge: opts.showAlerts === false ? 0 : (st.openAlerts > 0 ? st.openAlerts : 0),
        label: opts.showLabels === false ? null : st.short,
        labelSub: opts.showLabels === false ? null : `${st.soc.toFixed(0)}%`, /* v1.1：常驻标签只留 SOC%，功率/温度移入 hover 详情 */
        /* v1.1.2：站点标签独立偏移（世界坐标），为 v1.2 碰撞避让预留——
           DATA.STATIONS[].labelOffset = {dx, dz} 可选配置；缺省 0 时行为与 v1.1 完全一致 */
        labelDx: st.labelOffset ? st.labelOffset.dx || 0 : 0,
        labelDz: st.labelOffset ? st.labelOffset.dz || 0 : 0,
        labelColor: st.hasCrit ? '#f2bdb3' : '#d3e3f0',
        subColor: st.hasCrit ? '#dd9b8f' : '#8ea3b7',
        data: st
      });

      if (opts.showLinks !== false) {
        links.push({
          from: { x: st.x, z: st.z },
          to: { x: HUB.x, z: HUB.z },
          flow: st.comm === 'offline' ? 0 : (st.power >= 0 ? 1 : -1),
          width: 0.8 + Math.min(1.4, Math.abs(st.power) / 70),
          color: st.comm === 'offline' ? 'rgba(91,107,122,.2)' : 'rgba(120,182,220,.42)',
          dot: 'rgba(140,220,235,.5)'
        });
      }
    });

    return {
      objects, links,
      ground: { x: 620, z: 400 },
      gridStep: 100,
      region: {
        points: REGION_PTS,
        label: '苏南区域储能集群 · 8 站 / 1.24 GWh',
        labelX: -470, labelZ: 236
      },
      cam: { yaw: -0.55, pitch: 0.62, dist: 1150, target: { x: 0, y: 0, z: 20 } } /* v1.1：拉近镜头，站点聚拢减少空洞 */
    };
  }

  /* ---------------- 站内 ---------------- */
  function station(st, opts) {
    opts = opts || {};
    const objects = [];
    const links = [];
    const cabins = st.cabinList || [];
    const perRow = Math.ceil(cabins.length / 2);
    const gap = 78;
    const startX = -((perRow - 1) * gap) / 2;

    // 场坪
    objects.push({
      kind:'pad', pos:{ x:0, y:0, z:0 }, size:{ w:340, d:210 },
      color:'rgba(15,29,43,.72)', stroke:'rgba(126,163,196,.18)', lane:true
    });

    // 电池舱（两列布置）
    cabins.forEach((cab, i) => {
      const row = i < perRow ? 0 : 1;
      const col = row === 0 ? i : i - perRow;
      const total = row === 0 ? Math.min(perRow, cabins.length) : cabins.length - perRow;
      const sx = -((total - 1) * gap) / 2;
      const x = sx + col * gap;
      const z = row === 0 ? -44 : 46;
      const warn = cab.clusters.filter(c => c.status === 'warn').length > 0;
      objects.push({
        kind:'box', id: cab.id,
        pos:{ x, y:0, z }, size:{ w:64, h:33, d:38 },
        color: warn ? COL.warn : COL.steel,
        detail: 4,
        label: opts.showLabels === false ? null : cab.name,
        labelSub: opts.showLabels === false ? null : `${cab.soc.toFixed(1)}% · ${cab.temp.toFixed(1)}℃`,
        data: { type:'cabin', stationId: st.id, cabinId: cab.id, cabinIndex: cab.idx }
      });
      // 舱到汇流柜的直流链路
      links.push({
        from:{ x, z }, to:{ x, z: 88 }, y:0.4,
        flow: st.status === 'charging' ? -1 : 1,
        color:'rgba(94,143,187,.22)', width:1
      });
    });

    // PCS 与升压变
    for (let i = 0; i < 4; i++) {
      objects.push({
        kind:'box', id:'PCS-' + (i + 1),
        pos:{ x:-84 + i * 54, y:0, z:108 }, size:{ w:30, h:19, d:24 },
        color: COL.pcs, detail: 3, showLabel:false
      });
    }
    objects.push({
      kind:'box', id:'TR-1', pos:{ x:118, y:0, z:104 }, size:{ w:38, h:22, d:30 },
      color:'#34424e', label: opts.showLabels === false ? null : '主变 / 并网柜',
      labelSub:'35kV', showLabel:true
    });

    // 站控楼
    objects.push({
      kind:'box', id:'BLD', pos:{ x:-108, y:0, z:-108 }, size:{ w:58, h:34, d:40 },
      color: COL.building, detail: 5,
      label: opts.showLabels === false ? null : '站控楼 / EMS',
      labelSub:'运行值班 · 双机热备'
    });
    // 消防与辅助
    objects.push({
      kind:'box', id:'FIRE', pos:{ x:-20, y:0, z:-108 }, size:{ w:26, h:14, d:22 },
      color:'#2c3a45', showLabel:false
    });

    // 围墙
    const fence = [
      [{x:-170,z:-105},{x:-170,z:105}], [{x:170,z:-105},{x:170,z:105}],
      [{x:-170,z:-105},{x:170,z:-105}], [{x:-170,z:105},{x:170,z:105}]
    ];
    fence.forEach(f => links.push({ from:f[0], to:f[1], solid:true, color:'rgba(126,163,196,.13)', width:1, y:0.5 }));

    return {
      objects, links,
      ground: { x: 260, z: 190 },
      gridStep: 50,
      cam: { yaw: -0.78, pitch: 0.5, dist: 540, target: { x: 0, y: 0, z: 10 } }
    };
  }

  /* ---------------- 舱内电池簇 ---------------- */
  function cabin(st, cab, opts) {
    opts = opts || {};
    const objects = [];
    const links = [];
    const perRow = Math.ceil(cab.clusters.length / 2);

    objects.push({
      kind:'pad', pos:{ x:0, y:0, z:0 }, size:{ w:196, d:150 },
      color:'rgba(12,25,37,.82)', stroke:'rgba(126,163,196,.16)'
    });

    cab.clusters.forEach((cl, i) => {
      const row = i < perRow ? 0 : 1;
      const col = row === 0 ? i : i - perRow;
      const total = row === 0 ? Math.min(perRow, cab.clusters.length) : cab.clusters.length - perRow;
      const step = 34;
      const x = -((total - 1) * step) / 2 + col * step;
      const z = row === 0 ? -46 : 46;
      objects.push({
        kind:'box', id: cl.id,
        pos:{ x, y:0, z }, size:{ w:25, h:64, d:25 },
        color: cl.status === 'warn' ? '#7d5030' : '#20404f',
        detail: 7, edge:'rgba(9,18,26,.5)',
        label: opts.showLabels === false ? null : cl.id,
        labelSub: opts.showLabels === false ? null : `${cl.soc.toFixed(0)}% ${cl.temp.toFixed(0)}℃`,
        data:{ type:'cluster', stationId: st.id, cabinId: cab.id, cabinIndex: cab.idx, clusterId: cl.id }
      });
    });

    // 通道虚线
    links.push({ from:{x:-92,z:0}, to:{x:92,z:0}, y:0.4, solid:true, color:'rgba(126,163,196,.14)', width:1 });
    links.push({ from:{x:-92,z:-46}, to:{x:-92,z:46}, y:0.4, solid:true, color:'rgba(126,163,196,.10)', width:1 });
    links.push({ from:{x:92,z:-46}, to:{x:92,z:46}, y:0.4, solid:true, color:'rgba(126,163,196,.10)', width:1 });

    // 汇流母排
    links.push({ from:{x:-92,z:-46}, to:{x:92,z:-46}, y:66, solid:true, color:'rgba(63,182,201,.3)', width:1.6 });
    links.push({ from:{x:-92,z:46}, to:{x:92,z:46}, y:66, solid:true, color:'rgba(63,182,201,.3)', width:1.6 });
    links.push({ from:{x:0,z:-46}, to:{x:0,z:46}, y:66, solid:true, color:'rgba(63,182,201,.16)', width:1 });

    return {
      objects, links,
      ground: { x: 160, z: 130 },
      gridStep: 25,
      cam: { yaw: -0.62, pitch: 0.52, dist: 430, target: { x: 0, y: 22, z: 0 } }
    };
  }

  global.Scenes = { map, station, cabin, HUB, COL };
})(window);

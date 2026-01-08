/**
 * editor-subcomponents.js
 *
 * Cambios solicitados:
 * 1) Vértices "MERGE" por defecto (grupos por posición). Botón EXPLODE para separar.
 * 2) Gizmo de subcomponentes lo maneja core con escala 0.5 (ya aplicado).
 * 3) Selección dinámica/múltiple: toggle pick sin cerrar operación.
 *
 * Implementación:
 * - Mantiene una "selección" de grupos (cada grupo contiene índices de vértices).
 * - En MERGE (explode=false): pick de un vértice => selecciona todo el grupo coincidente.
 * - En EXPLODE (explode=true): pick => selecciona solo el índice tocado.
 * - La selección puede contener múltiples items (vertices/edges/faces).
 * - El gizmo se centra en el promedio de los centroides de cada item.
 * - Movimiento aplica el mismo delta local a TODOS los índices únicos seleccionados.
 * - Commit genera acción undo/redo: {type:'subEdit', id, indices:[...unique], delta:{x,y,z}}
 * - Cancel revierte a baseline (snapshot de posiciones base).
 */

export function setupSubcomponents(api) {
  const { THREE, CFG, scene, findObjectById } = api;

  const state = {
    flags: { verts: true, edges: false, faces: false, explode: false },
    selection: [], // [{kind:'v'|'e'|'f', key:string, indices:number[], centroidLocal:Vector3}]
    baseline: null // { id, positions: Float32Array copy }
  };

  /* =============================
     FLAGS
  ============================ */
  function getFlags() { return { ...state.flags }; }
  function setFlags(patch) {
    state.flags = { ...state.flags, ...patch };
  }

  /* =============================
     HELPERS: baseline snapshots
  ============================ */
  function setBaselineFromCurrent() {
    const obj = getSelectedObject();
    if (!obj) return;
    const pos = obj.geometry?.attributes?.position;
    if (!pos) return;
    state.baseline = {
      id: obj.userData.id,
      positions: new Float32Array(pos.array) // copy
    };
  }

  function cancelToBaseline() {
    const obj = getSelectedObject();
    if (!obj || !state.baseline || state.baseline.id !== obj.userData.id) return;
    const pos = obj.geometry?.attributes?.position;
    if (!pos) return;

    pos.array.set(state.baseline.positions);
    pos.needsUpdate = true;
    obj.geometry.computeVertexNormals();
    obj.geometry.computeBoundingBox();
    obj.geometry.computeBoundingSphere();
    refreshHelpers(obj);
  }

  function getSelectedObject() {
    // We can infer selected by checking which object has visible sub helpers, but simplest: store via selection baseline id.
    // Core calls togglePick(raycaster,obj) with obj, so we don't need to fetch selected here too often.
    // For baseline/cancel/commit, we look up by baseline.id or last used.
    if (state.baseline?.id != null) return findObjectById(state.baseline.id);
    return null;
  }

  /* =============================
     HELPERS: build vertex groups (MERGE)
  ============================ */
  const GROUP_EPS = 1e-4;

  function keyForPos(x, y, z) {
    // quantize
    const qx = Math.round(x / GROUP_EPS);
    const qy = Math.round(y / GROUP_EPS);
    const qz = Math.round(z / GROUP_EPS);
    return `${qx}_${qy}_${qz}`;
  }

  function buildVertexGroups(obj) {
    const pos = obj.geometry?.attributes?.position;
    if (!pos) return new Map();

    const map = new Map(); // key -> indices[]
    for (let i = 0; i < pos.count; i++) {
      const k = keyForPos(pos.getX(i), pos.getY(i), pos.getZ(i));
      const arr = map.get(k);
      if (arr) arr.push(i);
      else map.set(k, [i]);
    }
    return map;
  }

  function getGroupForVertexIndex(obj, idx) {
    // if explode => single index group
    if (state.flags.explode) return { key: `i:${idx}`, indices: [idx] };

    const pos = obj.geometry?.attributes?.position;
    if (!pos) return { key: `i:${idx}`, indices: [idx] };

    const k = keyForPos(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
    // Build groups on demand (fast enough for mobile primitives)
    const groups = buildVertexGroups(obj);
    const indices = groups.get(k) ?? [idx];
    return { key: `g:${k}`, indices };
  }

  /* =============================
     VISUAL HELPERS (points/edges/wire)
  ============================ */
  function ensureHelpers(obj) {
    if (!obj || !obj.geometry) return;
    if (!obj.userData.sub) obj.userData.sub = {};

    // Vertex points: duplicate positions (same as geometry)
    if (!obj.userData.sub.vertexPoints) {
      const geom = obj.geometry;
      const posAttr = geom.attributes.position;

      const ptsGeo = new THREE.BufferGeometry();
      ptsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posAttr.array), 3));

      const col = new Float32Array(posAttr.count * 3);
      for (let i = 0; i < posAttr.count; i++) {
        col[i*3+0] = 1; col[i*3+1] = 1; col[i*3+2] = 1;
      }
      ptsGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));

      const ptsMat = new THREE.PointsMaterial({
        size: 0.16,
        vertexColors: true,
        depthTest: false,
        transparent: true,
        opacity: 0.95
      });

      const pts = new THREE.Points(ptsGeo, ptsMat);
      pts.renderOrder = 998;
      pts.visible = false;
      pts.name = 'VertexPoints';
      obj.add(pts);
      obj.userData.sub.vertexPoints = pts;
    }

    // Edge helper
    if (!obj.userData.sub.edgeLines) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(obj.geometry),
        new THREE.LineBasicMaterial({ color: CFG.subAccent, transparent: true, opacity: 0.55, depthTest: false })
      );
      edges.visible = false;
      edges.renderOrder = 997;
      edges.name = 'EdgeLines';
      obj.add(edges);
      obj.userData.sub.edgeLines = edges;
    }

    // Face wire
    if (!obj.userData.sub.faceWire) {
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(obj.geometry),
        new THREE.LineBasicMaterial({ color: CFG.subAccent, transparent: true, opacity: 0.35, depthTest: false })
      );
      wire.visible = false;
      wire.renderOrder = 996;
      wire.name = 'FaceWire';
      obj.add(wire);
      obj.userData.sub.faceWire = wire;
    }
  }

  function refreshHelpers(obj) {
    if (!obj?.userData?.sub) return;

    // update points positions
    const pts = obj.userData.sub.vertexPoints;
    if (pts) {
      const src = obj.geometry.attributes.position.array;
      const dst = pts.geometry.attributes.position;
      dst.array.set(src);
      dst.needsUpdate = true;
    }

    // rebuild edges / wire to match modified geometry
    if (obj.userData.sub.edgeLines) {
      obj.remove(obj.userData.sub.edgeLines);
      obj.userData.sub.edgeLines.geometry.dispose();
      obj.userData.sub.edgeLines.material.dispose();
      obj.userData.sub.edgeLines = null;
    }
    if (obj.userData.sub.faceWire) {
      obj.remove(obj.userData.sub.faceWire);
      obj.userData.sub.faceWire.geometry.dispose();
      obj.userData.sub.faceWire.material.dispose();
      obj.userData.sub.faceWire = null;
    }

    ensureHelpers(obj);
    applySubVisibility(obj);
    recolorSelection(obj);
  }

  function applySubVisibility(obj) {
    ensureHelpers(obj);
    obj.userData.sub.vertexPoints.visible = !!state.flags.verts;
    obj.userData.sub.edgeLines.visible = !!state.flags.edges;
    obj.userData.sub.faceWire.visible = !!state.flags.faces;
    // Keep selection colors consistent
    recolorSelection(obj);
  }

  /* =============================
     SELECTION MANAGEMENT
  ============================ */
  function clearSelection() {
    state.selection = [];
    // baseline becomes current (so cancel doesn't surprise)
    setBaselineFromCurrent();
  }
  function hasSelection() { return state.selection.length > 0; }

  function makeSelectionKey(kind, key, indices) {
    if (kind === 'v') return `v:${key}`;
    // edges/faces don't have stable keys: use sorted indices signature
    const sig = indices.slice().sort((a,b)=>a-b).join(',');
    return `${kind}:${sig}`;
  }

  function selectionIndexByKey(selKey) {
    return state.selection.findIndex(s => s.key === selKey);
  }

  function centroidLocalFromIndices(obj, indices) {
    const pos = obj.geometry.attributes.position;
    const c = new THREE.Vector3();
    for (const i of indices) c.add(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    return c.multiplyScalar(1 / Math.max(1, indices.length));
  }

  function recolorSelection(obj) {
    if (!obj?.userData?.sub?.vertexPoints) return;
    const pts = obj.userData.sub.vertexPoints;
    const col = pts.geometry.attributes.color;

    // reset all to white
    for (let i = 0; i < col.count; i++) col.setXYZ(i, 1, 1, 1);

    // mark selected indices (blue-ish)
    const selectedSet = new Set();
    state.selection.forEach(s => s.indices.forEach(i => selectedSet.add(i)));
    selectedSet.forEach(i => col.setXYZ(i, 0.2, 0.7, 1.0));

    col.needsUpdate = true;
  }

  function getSelectionWorldCenter() {
    const obj = getSelectedObject();
    if (!obj || !hasSelection()) return null;

    const c = new THREE.Vector3();
    for (const s of state.selection) {
      const w = obj.localToWorld(s.centroidLocal.clone());
      c.add(w);
    }
    c.multiplyScalar(1 / state.selection.length);
    return c;
  }

  function getSelectionWorldCenterForObject(obj) {
    if (!obj || !hasSelection()) return null;
    const c = new THREE.Vector3();
    for (const s of state.selection) {
      const w = obj.localToWorld(s.centroidLocal.clone());
      c.add(w);
    }
    c.multiplyScalar(1 / state.selection.length);
    return c;
  }

  /* =============================
     PICKING SUBCOMPONENTS (togglePick)
  ============================ */
  function approximateEdgeByNearest(obj, worldPoint) {
    const geom = obj.geometry;
    const pos = geom.attributes.position;
    const local = obj.worldToLocal(worldPoint.clone());

    let best = -1, bestD = Infinity;
    for (let i=0; i<pos.count; i++){
      const dx = pos.getX(i) - local.x;
      const dy = pos.getY(i) - local.y;
      const dz = pos.getZ(i) - local.z;
      const d = dx*dx + dy*dy + dz*dz;
      if (d < bestD){ bestD = d; best = i; }
    }
    if (best < 0) return null;

    let best2 = -1, bestD2 = Infinity;
    for (let i=0; i<pos.count; i++){
      if (i === best) continue;
      const dx = pos.getX(i) - local.x;
      const dy = pos.getY(i) - local.y;
      const dz = pos.getZ(i) - local.z;
      const d = dx*dx + dy*dy + dz*dz;
      if (d < bestD2){ bestD2 = d; best2 = i; }
    }
    if (best2 < 0) return null;
    return [best, best2];
  }

  /**
   * togglePick(raycaster, obj):
   * - returns true if selection changed
   */
  function togglePick(raycaster, obj) {
    ensureHelpers(obj);

    // Ensure baseline exists once we start editing
    if (!state.baseline || state.baseline.id !== obj.userData.id) {
      state.baseline = null;
      setBaselineFromCurrent();
    }

    // 1) vertex pick
    if (state.flags.verts && obj.userData.sub.vertexPoints) {
      const hits = raycaster.intersectObject(obj.userData.sub.vertexPoints, true);
      if (hits.length) {
        const idx = hits[0].index;

        const grp = getGroupForVertexIndex(obj, idx); // merge/explode respected
        const centroidLocal = centroidLocalFromIndices(obj, grp.indices);
        const selKey = makeSelectionKey('v', grp.key, grp.indices);

        const existing = selectionIndexByKey(selKey);
        if (existing >= 0) state.selection.splice(existing, 1);
        else state.selection.push({ kind: 'v', key: selKey, indices: grp.indices.slice(), centroidLocal });

        recolorSelection(obj);
        return true;
      }
    }

    // 2) edge pick
    if (state.flags.edges && obj.userData.sub.edgeLines) {
      const hits = raycaster.intersectObject(obj.userData.sub.edgeLines, true);
      if (hits.length) {
        const p = hits[0].point.clone();
        const pair = approximateEdgeByNearest(obj, p);
        if (!pair) return false;

        const centroidLocal = centroidLocalFromIndices(obj, pair);
        const selKey = makeSelectionKey('e', 'edge', pair);
        const existing = selectionIndexByKey(selKey);
        if (existing >= 0) state.selection.splice(existing, 1);
        else state.selection.push({ kind: 'e', key: selKey, indices: pair.slice(), centroidLocal });

        recolorSelection(obj);
        return true;
      }
    }

    // 3) face pick (raycast mesh)
    if (state.flags.faces) {
      const hits = raycaster.intersectObject(obj, false);
      if (hits.length) {
        const f = hits[0].face;
        if (!f) return false;
        const tri = [f.a, f.b, f.c];
        const centroidLocal = centroidLocalFromIndices(obj, tri);
        const selKey = makeSelectionKey('f', 'face', tri);
        const existing = selectionIndexByKey(selKey);
        if (existing >= 0) state.selection.splice(existing, 1);
        else state.selection.push({ kind: 'f', key: selKey, indices: tri.slice(), centroidLocal });

        recolorSelection(obj);
        return true;
      }
    }

    return false;
  }

  /* =============================
     APPLY MOVEMENT: world delta -> local delta -> apply to unique indices
  ============================ */
  let accumulatedLocalDelta = new THREE.Vector3(0,0,0);

  function applySelectionWorldDelta(obj, worldDelta) {
    if (!hasSelection()) return 0;

    // world -> local delta
    const p0 = obj.worldToLocal(obj.position.clone());
    const p1 = obj.worldToLocal(obj.position.clone().add(worldDelta));
    const dLocal = p1.sub(p0);

    // apply to unique vertex indices across selection
    const unique = new Set();
    state.selection.forEach(s => s.indices.forEach(i => unique.add(i)));

    const pos = obj.geometry.attributes.position;
    unique.forEach(i => {
      pos.setXYZ(i,
        pos.getX(i) + dLocal.x,
        pos.getY(i) + dLocal.y,
        pos.getZ(i) + dLocal.z
      );
    });

    pos.needsUpdate = true;
    obj.geometry.computeVertexNormals();
    obj.geometry.computeBoundingBox();
    obj.geometry.computeBoundingSphere();

    // update centroids (local)
    state.selection.forEach(s => { s.centroidLocal.add(dLocal); });

    accumulatedLocalDelta.add(dLocal);

    refreshHelpers(obj);

    // moved distance in world (for camera helper)
    const beforeCenterW = getSelectionWorldCenterForObject(obj);
    // after update, compute new center
    const afterCenterW = getSelectionWorldCenterForObject(obj);
    if (!beforeCenterW || !afterCenterW) return dLocal.length();
    return afterCenterW.distanceTo(beforeCenterW);
  }

  /* =============================
     COMMIT / ACTION (undo/redo)
  ============================ */
  function commitSelectionDeltaAsAction(objectId) {
    if (!objectId) return null;
    if (!hasSelection()) return null;
    if (accumulatedLocalDelta.lengthSq() < 1e-12) return null;

    // unique indices
    const unique = new Set();
    state.selection.forEach(s => s.indices.forEach(i => unique.add(i)));
    const indices = Array.from(unique);

    const d = accumulatedLocalDelta.clone();
    accumulatedLocalDelta.set(0,0,0);

    // new baseline after commit will be handled by core calling setBaselineFromCurrent()
    return {
      type: 'subEdit',
      id: objectId,
      indices,
      delta: { x: d.x, y: d.y, z: d.z }
    };
  }

  function applyDeltaLocalToIndices(obj, indices, dLocal) {
    const pos = obj.geometry.attributes.position;
    for (const i of indices) {
      pos.setXYZ(i,
        pos.getX(i) + dLocal.x,
        pos.getY(i) + dLocal.y,
        pos.getZ(i) + dLocal.z
      );
    }
    pos.needsUpdate = true;
    obj.geometry.computeVertexNormals();
    obj.geometry.computeBoundingBox();
    obj.geometry.computeBoundingSphere();
    refreshHelpers(obj);
  }

  function applySubEditForward(action) {
    const obj = findObjectById(action.id);
    if (!obj) return;
    applyDeltaLocalToIndices(obj, action.indices, new THREE.Vector3(action.delta.x, action.delta.y, action.delta.z));
  }
  function applySubEditInverse(action) {
    const obj = findObjectById(action.id);
    if (!obj) return;
    applyDeltaLocalToIndices(obj, action.indices, new THREE.Vector3(-action.delta.x, -action.delta.y, -action.delta.z));
  }

  /* =============================
     PUBLIC API
  ============================ */
  return {
    getFlags,
    setFlags,

    applySubVisibility,

    togglePick,
    clearSelection,
    hasSelection,

    getSelectionWorldCenter,

    applySelectionWorldDelta,

    setBaselineFromCurrent,
    cancelToBaseline,
    commitSelectionDeltaAsAction,

    applySubEditForward,
    applySubEditInverse
  };
}

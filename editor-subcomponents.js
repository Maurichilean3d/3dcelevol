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
  const triggersSystem = setupTriggersSystem(api, state);

  const state = {
  multiDone: false,

    flags: { verts: true, edges: false, faces: false, explode: false,
    multi: false },
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
        size: 0.10,
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
  
/* TRIGGERS_ORBS_SYSTEM
   Finger-friendly subelement selection using large invisible hit spheres + optional visible orbs.
   - When multi selection is ON, per-element orbs are hidden while picking; only after "Listo" a group orb appears.
   - Depth-priority: raycaster already returns nearest first; selected orbs are colored/opacity by camera distance.
*/
function setupTriggersSystem(api, state) {
  const { THREE, scene } = api;

  function ensureSub(obj) {
    obj.userData.sub = obj.userData.sub || {};
    return obj.userData.sub;
  }

  function clearGroup(g) {
    if (!g) return;
    while (g.children.length) g.remove(g.children[0]);
  }

  function getGeom(obj) {
    const geom = obj.geometry;
    if (!geom || !geom.attributes || !geom.attributes.position) return null;
    return geom;
  }

  function getIndexArray(geom) {
    if (geom.index && geom.index.array) return geom.index.array;
    // non-indexed: make a trivial index
    const n = geom.attributes.position.count;
    const arr = new Uint32Array(n);
    for (let i = 0; i < n; i++) arr[i] = i;
    return arr;
  }

  function v3FromPos(pos, i, out) {
    out.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    return out;
  }

  // approximate finger size in world units: keep ~constant screen size by scaling with distance
  function worldRadiusForDist(dist) {
    // tuned for mobile: ~3/4 finger ~ 28-32px; this constant works reasonably with typical FOV.
    return Math.max(0.03 * dist, 0.02);
  }

  function makeOrbMesh() {
    const geom = new THREE.SphereGeometry(1, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00f2ff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 9999;
    return mesh;
  }

  function makeHitMesh() {
    const geom = new THREE.SphereGeometry(1, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 9998;
    return mesh;
  }

  function buildTriggers(obj) {
    const sub = ensureSub(obj);
    const geom = getGeom(obj);
    if (!geom) return;

    // holder group in world space
    if (!sub.triggerGroup) {
      sub.triggerGroup = new THREE.Group();
      sub.triggerGroup.name = "sub_triggerGroup";
      scene.add(sub.triggerGroup);
    }
    clearGroup(sub.triggerGroup);

    sub.triggerItems = [];
    sub.triggerHitToItem = new Map();

    const pos = geom.attributes.position;
    const idx = getIndexArray(geom);

    const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
    const tmpW = new THREE.Vector3();

    const addItem = (kind, key, indices, localCenter) => {
      const orb = makeOrbMesh();
      const hit = makeHitMesh();

      // store metadata on hit & orb
      hit.userData.subItemKey = key;
      orb.userData.subItemKey = key;
      hit.userData.kind = kind;
      orb.userData.kind = kind;

      sub.triggerGroup.add(hit);
      sub.triggerGroup.add(orb);

      const item = { kind, key, indices, localCenter: localCenter.clone(), orb, hit, selected: false };
      sub.triggerItems.push(item);
      sub.triggerHitToItem.set(hit.uuid, item);
      sub.triggerHitToItem.set(orb.uuid, item);
    };

    // Vertices: one item per vertex index group (MERGE/EXPLODE handled later by your existing getGroupForVertexIndex)
    if (state.flags.verts) {
      for (let i = 0; i < pos.count; i++) {
        tmpA.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        const key = "v:" + i;
        addItem("v", key, [i], tmpA);
      }
    }

    // Edges: unique edges from indexed triangles
    if (state.flags.edges) {
      const edgeSet = new Set();
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const a = idx[i], b = idx[i+1], c = idx[i+2];
        const pairs = [[a,b],[b,c],[c,a]];
        for (const [u,v] of pairs) {
          const x = Math.min(u,v), y = Math.max(u,v);
          const ek = x + "_" + y;
          if (edgeSet.has(ek)) continue;
          edgeSet.add(ek);
          v3FromPos(pos, x, tmpA);
          v3FromPos(pos, y, tmpB);
          tmpC.copy(tmpA).add(tmpB).multiplyScalar(0.5);
          addItem("e", "e:" + ek, [x,y], tmpC);
        }
      }
    }

    // Faces: per-triangle centroid
    if (state.flags.faces) {
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const a = idx[i], b = idx[i+1], c = idx[i+2];
        v3FromPos(pos, a, tmpA);
        v3FromPos(pos, b, tmpB);
        v3FromPos(pos, c, tmpC);
        tmpW.copy(tmpA).add(tmpB).add(tmpC).multiplyScalar(1/3);
        addItem("f", "f:" + i, [a,b,c], tmpW);
      }
    }

    // Group orb (appears after multi "Listo" or for single selection as handle)
    if (!sub.groupOrb) {
      sub.groupOrb = makeOrbMesh();
      sub.groupOrb.material.color.setHex(0xffd400); // amber for group handle
      sub.groupOrb.material.opacity = 0.95;
      sub.groupOrb.userData.isGroupOrb = true;
      sub.groupOrb.renderOrder = 10000;
      scene.add(sub.groupOrb);
    }
    sub.groupOrb.visible = false;

    syncTriggerVisibility(obj);
  }

  function syncTriggerVisibility(obj) {
    const sub = ensureSub(obj);
    if (!sub.triggerItems) return;
    const multi = !!state.flags.multi;
    const done = !!state.multiDone;

    for (const it of sub.triggerItems) {
      // hit is always active when that kind is enabled
      it.hit.visible = true;
      // orbs are visible in single mode, or after multi done (show only selected)
      if (!multi) {
        it.orb.visible = true;
        it.orb.material.opacity = it.selected ? 0.95 : 0.35;
      } else {
        if (done && it.selected) {
          it.orb.visible = true;
          it.orb.material.opacity = 0.95;
        } else {
          it.orb.visible = false;
        }
      }
    }

    if (sub.groupOrb) {
      sub.groupOrb.visible = multi && done && state.selection.length >= 2;
    }
  }

  function updateTriggerTransforms(obj, camera) {
    const sub = ensureSub(obj);
    if (!sub.triggerItems) return;

    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);

    const tmp = new THREE.Vector3();
    for (const it of sub.triggerItems) {
      // compute world position of localCenter
      tmp.copy(it.localCenter);
      tmp.applyMatrix4(obj.matrixWorld);

      it.orb.position.copy(tmp);
      it.hit.position.copy(tmp);

      const dist = camPos.distanceTo(tmp);
      const r = worldRadiusForDist(dist);
      it.hit.scale.setScalar(r);         // big invisible trigger
      it.orb.scale.setScalar(r * 0.35);  // smaller visible orb

      // depth-correlated visual for selected orbs (nearer => more solid/bright)
      if (it.selected && it.orb.visible) {
        const t = Math.min(Math.max((dist - 0.5) / 6.0, 0), 1); // normalize
        const opacity = 1.0 - 0.6 * t; // far -> 0.4
        it.orb.material.opacity = opacity;
      }
    }

    if (sub.groupOrb && sub.groupOrb.visible) {
      const center = getSelectionWorldCenter(obj);
      if (center) {
        sub.groupOrb.position.copy(center);
        const dist = camPos.distanceTo(center);
        const r = worldRadiusForDist(dist);
        sub.groupOrb.scale.setScalar(r * 0.45);
      }
    }
  }

  function selectItem(obj, item, toggle) {
    // convert trigger item to your existing selection items structure
    if (!toggle) {
      // clear all
      for (const it of obj.userData.sub.triggerItems) it.selected = false;
      state.selection.length = 0;
    }
    item.selected = toggle ? !item.selected : true;

    // sync state.selection from trigger selections
    state.selection.length = 0;
    for (const it of obj.userData.sub.triggerItems) {
      if (!it.selected) continue;
      state.selection.push({ kind: it.kind, key: it.key, indices: it.indices.slice(), centroidLocal: it.localCenter.clone() });
    }

    // recolor using your existing recolorSelection
    recolorSelection(obj);
    syncTriggerVisibility(obj);
  }

  function getSelectionWorldCenter(obj) {
    if (!state.selection || state.selection.length === 0) return null;
    const c = new THREE.Vector3();
    for (const s of state.selection) c.add(s.centroidLocal);
    c.multiplyScalar(1 / state.selection.length);
    c.applyMatrix4(obj.matrixWorld);
    return c;
  }

  function handleTap(raycaster, obj) {
    const sub = ensureSub(obj);
    if (!sub.triggerGroup || !sub.triggerItems) return { action: "none" };

    // Update matrices
    sub.triggerGroup.updateMatrixWorld(true);

    // Intersect triggers and group orb
    const candidates = [];
    if (sub.groupOrb && sub.groupOrb.visible) candidates.push(sub.groupOrb);
    for (const it of sub.triggerItems) {
      if (it.hit.visible) candidates.push(it.hit);
    }

    const hits = raycaster.intersectObjects(candidates, true);
    if (!hits || hits.length === 0) return { action: "none" };

    const hitObj = hits[0].object;
    if (hitObj.userData && hitObj.userData.isGroupOrb) {
      const center = getSelectionWorldCenter(obj);
      if (center) return { action: "showGizmo", center, kind: "group" };
      return { action: "none" };
    }

    const item = sub.triggerHitToItem.get(hitObj.uuid);
    if (!item) return { action: "none" };

    const multi = !!state.flags.multi;
    const toggle = multi; // multi mode toggles
    if (multi && state.multiDone) {
      // after done, tap on selected orb just shows gizmo too
      if (item.selected) {
        const center = item.localCenter.clone().applyMatrix4(obj.matrixWorld);
        return { action: "showGizmo", center, kind: item.kind };
      }
      // allow continue selecting? ignore
      return { action: "none" };
    }

    selectItem(obj, item, toggle);

    if (!multi) {
      const center = item.localCenter.clone().applyMatrix4(obj.matrixWorld);
      return { action: "showGizmo", center, kind: item.kind };
    }
    return { action: "none" };
  }

  function setMulti(on, obj) {
    state.flags.multi = !!on;
    state.multiDone = false;
    if (obj) syncTriggerVisibility(obj);
  }

  function finishMulti(obj) {
    state.multiDone = true;
    if (obj) syncTriggerVisibility(obj);
  }

  return { buildTriggers, updateTriggerTransforms, handleTap, setMulti, finishMulti, getSelectionWorldCenter };
  try { triggersSystem.buildTriggers(obj); } catch(e) {}
}

return {
    getFlags,
    setFlags,

    applySubVisibility,

    togglePick,
    clearSelection,
    hasSelection,

    getSelectionWorldCenter,
    handleTap: (raycaster, obj)=>triggersSystem.handleTap(raycaster, obj),
    updateTriggerTransforms: (obj, camera)=>triggersSystem.updateTriggerTransforms(obj, camera),
    setMulti: (on, obj)=>triggersSystem.setMulti(on, obj),
    finishMulti: (obj)=>triggersSystem.finishMulti(obj),

    applySelectionWorldDelta,

    setBaselineFromCurrent,
    cancelToBaseline,
    commitSelectionDeltaAsAction,

    applySubEditForward,
    applySubEditInverse
  };
}

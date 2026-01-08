/**
 * editor-subcomponents.js
 * Lógica de edición de mallas: Vértices, Bordes y Caras.
 */

export function setupSubcomponents(api) {
  const { THREE, CFG, findObjectById } = api;

  const state = {
    flags: { verts: true, edges: false, faces: false, explode: false },
    selection: [], // [{key, indices, centroidLocal}]
    baseline: null 
  };

  const getFlags = () => ({ ...state.flags });
  const setFlags = (patch) => { state.flags = { ...state.flags, ...patch }; };

  function setBaselineFromCurrent() {
    const obj = getSelectedObject();
    if (!obj) return;
    const pos = obj.geometry?.attributes?.position;
    state.baseline = { id: obj.userData.id, positions: new Float32Array(pos.array) };
  }

  function cancelToBaseline() {
    const obj = getSelectedObject();
    if (!obj || !state.baseline) return;
    const pos = obj.geometry.attributes.position;
    pos.array.set(state.baseline.positions);
    pos.needsUpdate = true;
    obj.geometry.computeVertexNormals();
    refreshHelpers(obj);
  }

  function getSelectedObject() {
    return state.baseline ? findObjectById(state.baseline.id) : null;
  }

  // Agrupación de vértices para "Merge"
  const GROUP_EPS = 1e-4;
  function keyForPos(x, y, z) {
    return `${Math.round(x/GROUP_EPS)}_${Math.round(y/GROUP_EPS)}_${Math.round(z/GROUP_EPS)}`;
  }

  function getGroupForVertexIndex(obj, idx) {
    if (state.flags.explode) return { key: `idx:${idx}`, indices: [idx] };
    const pos = obj.geometry.attributes.position;
    const k = keyForPos(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
    
    const indices = [];
    for (let i = 0; i < pos.count; i++) {
      if (keyForPos(pos.getX(i), pos.getY(i), pos.getZ(i)) === k) indices.push(i);
    }
    return { key: k, indices };
  }

  function ensureHelpers(obj) {
    if (!obj || obj.userData.sub?.vertexPoints) return;
    obj.userData.sub = obj.userData.sub || {};
    
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', obj.geometry.attributes.position.clone());
    const colors = new Float32Array(obj.geometry.attributes.position.count * 3).fill(1);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const pts = new THREE.Points(geom, new THREE.PointsMaterial({ 
      size: 0.15, vertexColors: true, depthTest: false, transparent: true, opacity: 0.8 
    }));
    pts.renderOrder = 999;
    obj.add(pts);
    obj.userData.sub.vertexPoints = pts;
  }

  function recolorSelection(obj) {
    const colAttr = obj.userData.sub?.vertexPoints?.geometry.attributes.color;
    if (!colAttr) return;
    for (let i = 0; i < colAttr.count; i++) colAttr.setXYZ(i, 1, 1, 1);
    state.selection.forEach(s => s.indices.forEach(idx => colAttr.setXYZ(idx, 0, 0.5, 1)));
    colAttr.needsUpdate = true;
  }

  function refreshHelpers(obj) {
    if (!obj.userData.sub?.vertexPoints) return;
    obj.userData.sub.vertexPoints.geometry.attributes.position.copy(obj.geometry.attributes.position);
    obj.userData.sub.vertexPoints.geometry.attributes.position.needsUpdate = true;
    recolorSelection(obj);
  }

  function getSelectionWorldCenter() {
    const obj = getSelectedObject();
    if (!obj || state.selection.length === 0) return null;
    const center = new THREE.Vector3();
    state.selection.forEach(s => center.add(obj.localToWorld(s.centroidLocal.clone())));
    return center.multiplyScalar(1 / state.selection.length);
  }

  function togglePick(raycaster, obj) {
    ensureHelpers(obj);
    if (!state.baseline) setBaselineFromCurrent();
    const hits = raycaster.intersectObject(obj.userData.sub.vertexPoints);
    if (hits.length > 0) {
      const { key, indices } = getGroupForVertexIndex(obj, hits[0].index);
      const existsIdx = state.selection.findIndex(s => s.key === key);
      if (existsIdx >= 0) state.selection.splice(existsIdx, 1);
      else {
        const pos = obj.geometry.attributes.position;
        const localC = new THREE.Vector3();
        indices.forEach(i => localC.add(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))));
        state.selection.push({ key, indices, centroidLocal: localC.multiplyScalar(1/indices.length) });
      }
      recolorSelection(obj);
      return true;
    }
    return false;
  }

  let accumulatedDelta = new THREE.Vector3();
  function applySelectionWorldDelta(obj, worldDelta) {
    const localDelta = worldDelta.clone().applyQuaternion(obj.quaternion.clone().invert());
    const pos = obj.geometry.attributes.position;
    const uniqueIndices = new Set();
    state.selection.forEach(s => {
      s.indices.forEach(i => uniqueIndices.add(i));
      s.centroidLocal.add(localDelta);
    });
    uniqueIndices.forEach(i => {
      pos.setXYZ(i, pos.getX(i) + localDelta.x, pos.getY(i) + localDelta.y, pos.getZ(i) + localDelta.z);
    });
    pos.needsUpdate = true;
    accumulatedDelta.add(localDelta);
    refreshHelpers(obj);
    return worldDelta.length();
  }

  function commitSelectionDeltaAsAction(objectId) {
    if (accumulatedDelta.length() < 0.0001) return null;
    const indices = [...new Set(state.selection.flatMap(s => s.indices))];
    const action = { type: 'subEdit', id: objectId, indices, delta: accumulatedDelta.clone() };
    accumulatedDelta.set(0,0,0);
    return action;
  }

  return { getFlags, setFlags, togglePick, clearSelection: () => { state.selection = []; state.baseline = null; }, 
           hasSelection: () => state.selection.length > 0, getSelectionWorldCenter, applySelectionWorldDelta, 
           setBaselineFromCurrent, cancelToBaseline, commitSelectionDeltaAsAction, 
           applySubVisibility: (obj) => { ensureHelpers(obj); obj.userData.sub.vertexPoints.visible = state.flags.verts; } };
}


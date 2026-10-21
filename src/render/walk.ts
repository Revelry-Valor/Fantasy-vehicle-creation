import * as THREE from 'three';
import type { Viewport } from './viewport';

/**
 * Walk-through mode at figure scale: eye height from the scale setting,
 * W/A/S/D (or arrows) to move, drag to look, Q/E to go down/up, Esc to leave.
 */
export class Walk {
  active = false;
  eye = 1.7;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private last = 0;
  private saved: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  onExit: () => void = () => {};

  constructor(private vp: Viewport) {
    window.addEventListener('keydown', (e) => { if (this.active) { this.keys.add(e.key.toLowerCase()); if (e.key === 'Escape') this.stop(); e.preventDefault(); } }, true);
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()), true);
    const el = vp.renderer.domElement;
    let drag: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => { if (this.active) { drag = { x: e.clientX, y: e.clientY }; e.stopImmediatePropagation(); } }, true);
    el.addEventListener('pointermove', (e) => {
      if (!this.active || !drag) return;
      this.yaw -= (e.clientX - drag.x) * 0.004;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch - (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
      e.stopImmediatePropagation();
    }, true);
    window.addEventListener('pointerup', () => (drag = null));
  }

  start(at: THREE.Vector3) {
    const cam = this.vp.camera;
    this.saved = { pos: cam.position.clone(), target: this.vp.controls.target.clone() };
    this.active = true;
    this.vp.controls.enabled = false;
    cam.position.set(at.x, at.y + this.eye, at.z);
    const d = this.saved.target.clone().sub(this.saved.pos);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = 0;
    this.last = performance.now();
    const tick = () => {
      if (!this.active) return;
      this.step();
      requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.vp.controls.enabled = true;
    if (this.saved) { this.vp.camera.position.copy(this.saved.pos); this.vp.controls.target.copy(this.saved.target); }
    this.vp.camera.near = 0.05;
    this.vp.camera.updateProjectionMatrix();
    this.vp.invalidate();
    this.onExit();
  }

  private step() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const cam = this.vp.camera;
    const speed = (this.keys.has('shift') ? 6 : 2.2) * (this.eye / 1.7);
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const m = new THREE.Vector3();
    if (this.keys.has('w') || this.keys.has('arrowup')) m.add(f);
    if (this.keys.has('s') || this.keys.has('arrowdown')) m.sub(f);
    if (this.keys.has('d') || this.keys.has('arrowright')) m.add(r);
    if (this.keys.has('a') || this.keys.has('arrowleft')) m.sub(r);
    if (this.keys.has('e')) m.y += 1;
    if (this.keys.has('q')) m.y -= 1;
    if (m.lengthSq()) cam.position.addScaledVector(m.normalize(), speed * dt);
    cam.near = 0.02;
    cam.updateProjectionMatrix();
    const look = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    cam.lookAt(cam.position.clone().add(look));
    this.vp.controls.target.copy(cam.position.clone().add(look));
    this.vp.invalidate();
  }
}

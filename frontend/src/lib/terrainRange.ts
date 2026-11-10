import * as THREE from 'three'

/** Share the original surface vertices and triangle indices inside a conservative
 * radius bounding box. No interpolated fan or bilinear surface can bridge a ridge.
 * Circular clipping happens per fragment on these exact terrain triangles. */
export function surfaceRangeGeometry(surface: THREE.BufferGeometry, width: number, depth: number,
  n: number, cx: number, cz: number, radius: number) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', surface.getAttribute('position'))
  const source = surface.getIndex()!
  const clamp = (v: number) => Math.max(0, Math.min(n - 2, v))
  const x0 = clamp(Math.floor(((cx - radius) / width + .5) * (n - 1)) - 1)
  const x1 = clamp(Math.ceil(((cx + radius) / width + .5) * (n - 1)) + 1)
  const z0 = clamp(Math.floor(((cz - radius) / depth + .5) * (n - 1)) - 1)
  const z1 = clamp(Math.ceil(((cz + radius) / depth + .5) * (n - 1)) + 1)
  const indices: number[] = []
  for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) {
    const start = (j * (n - 1) + i) * 6
    for (let k = 0; k < 6; k++) indices.push(source.getX(start + k))
  }
  geometry.setIndex(indices)
  return geometry
}

export function surfaceRangeMaterial(cx: number, cz: number, radius: number, color: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector2(cx, cz) },
      uRadius: { value: radius }, uWidth: { value: Math.max(2, radius * .018) },
      uColor: { value: new THREE.Color(color) }, uRingOpacity: { value: .8 },
    },
    vertexShader: `varying vec2 vPlane;
      void main() {
        vPlane = vec2(position.x, -position.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform vec2 uCenter;
      uniform float uRadius;
      uniform float uWidth;
      uniform vec3 uColor;
      uniform float uRingOpacity;
      varying vec2 vPlane;
      void main() {
        float r = length(vPlane - uCenter);
        float aa = max(fwidth(r), 0.35);
        float outer = 1.0 - smoothstep(uRadius - aa, uRadius + aa, r);
        if (outer <= 0.0) discard;
        float edge = smoothstep(uRadius - uWidth - aa, uRadius - uWidth + aa, r);
        float alpha = outer * mix(0.035, uRingOpacity, edge);
        gl_FragColor = vec4(uColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthTest: true, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true,
    polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  })
}

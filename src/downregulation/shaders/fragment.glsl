#version 300 es
precision mediump float;

in float v_alpha;

out vec4 outColor;

// Soft circular point with cool tone (cyan/blue/purple). Additive-style alpha.
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float soft = 1.0 - smoothstep(0.0, 0.5, d);
  float a = soft * v_alpha;

  // Cool palette: mix cyan, blue, purple
  vec3 col = mix(vec3(0.2, 0.5, 0.6), vec3(0.3, 0.35, 0.6), 0.5);
  col = mix(col, vec3(0.4, 0.3, 0.55), 0.3);
  outColor = vec4(col, a);
}

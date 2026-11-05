// Hijos de una vista sin valores falsy (null, undefined, false, 0, ''): replaceChildren() los pintaría
// como texto («null», «undefined»). Módulo sin DOM para poder probarlo con bun test.
export const visibles = (...nodos) => nodos.filter(Boolean);

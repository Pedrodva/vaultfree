// Minimal i18n: short UI labels (buttons, menus, tabs, titles) exist in English and Spanish.
// Longer explanations and help texts are intentionally English only.
const stored = (() => { try { return JSON.parse(localStorage.getItem('vf.lang')); } catch { return null; } })();
export const lang = stored || (typeof navigator !== 'undefined' && /^es/i.test(navigator.language) ? 'es' : 'en');
if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function setLang(l) { localStorage.setItem('vf.lang', JSON.stringify(l)); }

export const ES = {
  // auth
  'Username': 'Usuario', 'Display name (optional)': 'Nombre visible (opcional)', 'Password (min. 8)': 'Contraseña (mín. 8)',
  'Create account': 'Crear cuenta', 'Sign in': 'Iniciar sesión', 'I already have an account': 'Ya tengo cuenta', 'Create an account': 'Crear una cuenta',
  // ribbon & palette
  'Files': 'Archivos', 'Search (Ctrl+Shift+F)': 'Buscar (Ctrl+Mayús+F)', 'Graph view (Ctrl+G)': 'Vista de grafo (Ctrl+G)',
  'New note (Ctrl+N)': 'Nueva nota (Ctrl+N)', 'Daily note': 'Nota diaria', 'API tokens & AI (MCP)': 'Tokens de API e IA (MCP)',
  'Vault members': 'Miembros del vault', 'Invite & share online': 'Invitar y compartir online', 'Admin: users': 'Admin: usuarios',
  'Toggle theme': 'Cambiar tema', 'Language': 'Idioma',
  'Create new note': 'Crear nota nueva', 'Open daily note': 'Abrir nota diaria', 'Toggle graph view': 'Mostrar/ocultar vista de grafo',
  'Toggle light/dark theme': 'Cambiar tema claro/oscuro', 'Layout: editor only': 'Diseño: solo editor',
  'Layout: split editor + preview': 'Diseño: editor + vista previa', 'Layout: reading view': 'Diseño: vista de lectura',
  'Search in vault': 'Buscar en el vault', 'API tokens & MCP setup': 'Tokens de API y configuración MCP',
  'Invite people & share online': 'Invitar y compartir online', 'Create new vault': 'Crear vault nuevo',
  'Copy this vault (or a folder) to my own vault': 'Copiar este vault (o una carpeta) a mi propio vault',
  'Download vault export (JSON)': 'Descargar exportación del vault (JSON)', 'Sign out': 'Cerrar sesión', 'Delete current note': 'Eliminar la nota actual',
  // vaults / sidebar
  'No vaults yet': 'Aún no hay vaults', 'Create your first vault': 'Crea tu primer vault', '＋ New vault…': '＋ Nuevo vault…',
  'New note': 'Nueva nota', 'Search': 'Buscar', 'Tags': 'Etiquetas', 'New note here': 'Nueva nota aquí', 'Delete': 'Eliminar',
  'No results': 'Sin resultados', 'Search… "phrase" tag:x path:folder': 'Buscar… "frase" tag:x path:carpeta',
  // note view
  '✎ Edit': '✎ Editar', '◫ Split': '◫ Dividir', '👁 Read': '👁 Leer', 'Unsaved': 'Sin guardar', 'Unsaved…': 'Sin guardar…',
  'Saved': 'Guardado', 'Saving…': 'Guardando…', 'Conflict': 'Conflicto', 'No note open': 'Ninguna nota abierta',
  'Note title': 'Título de la nota', 'Note editor': 'Editor de notas',
  'Keep mine': 'Conservar la mía', 'Use theirs': 'Usar la suya', 'Merge manually': 'Fusionar a mano', 'Recreate it': 'Recrearla',
  // right panel
  'Links': 'Enlaces', 'Outline': 'Esquema', 'Graph': 'Grafo', 'History': 'Historial', 'None': 'Ninguno', 'Depth': 'Profundidad',
  'Open full graph': 'Abrir grafo completo', 'View': 'Ver', 'Restore': 'Restaurar',
  // graph view
  'Graph view': 'Vista de grafo', 'Close': 'Cerrar', 'Filters': 'Filtros', 'Groups': 'Grupos', 'Display': 'Visualización', 'Forces': 'Fuerzas',
  'Search files…': 'Buscar archivos…', 'All tags': 'Todas las etiquetas', 'Orphans': 'Huérfanos', 'Unresolved links': 'Enlaces sin resolver',
  'Color by folder': 'Color por carpeta', 'Arrows': 'Flechas', 'Text fade': 'Desvanecer texto', 'Node size': 'Tamaño de nodo',
  'Link thickness': 'Grosor de enlace', 'Center force': 'Fuerza central', 'Repel force': 'Fuerza de repulsión', 'Link force': 'Fuerza de enlace',
  'Link distance': 'Distancia de enlace', '＋ New group': '＋ Nuevo grupo',
  // dialogs
  'API tokens & AI integration': 'Tokens de API e integración con IA', 'Create': 'Crear', 'Revoke': 'Revocar', 'Name': 'Nombre',
  'Scopes': 'Permisos', 'Last used': 'Último uso', 'Read + write': 'Lectura + escritura', 'Read only': 'Solo lectura', 'never': 'nunca',
  'Add': 'Añadir', 'Remove': 'Quitar', 'Users': 'Usuarios', 'Add user': 'Añadir usuario', 'Create user': 'Crear usuario',
  'Administrator': 'Administrador', 'Enable': 'Activar', 'Disable': 'Desactivar', 'Initial password': 'Contraseña inicial',
  'Invite & share': 'Invitar y compartir', 'Can edit': 'Puede editar', 'Can only read': 'Solo puede leer', 'One person': 'Una persona',
  'Up to 5 people': 'Hasta 5 personas', 'Up to 25 people': 'Hasta 25 personas', 'Never expires': 'No caduca nunca',
  '1 day': '1 día', '3 days': '3 días', '7 days': '7 días', '30 days': '30 días', 'Create invite link': 'Crear enlace de invitación',
  'Copy': 'Copiar', 'Public address used in the link': 'Dirección pública usada en el enlace', 'Share online': 'Compartir online',
  'Start sharing online': 'Empezar a compartir online', 'Stop sharing': 'Dejar de compartir', 'Starting tunnel…': 'Iniciando túnel…',
  'Link copied': 'Enlace copiado', 'Address copied': 'Dirección copiada',
  'Allow members to copy / export this vault': 'Permitir a los miembros copiar / exportar este vault',
  'Copy this vault to my own vault…': 'Copiar este vault a mi propio vault…', 'Copy to my own vault': 'Copiar a mi propio vault',
  'New vault name': 'Nombre del nuevo vault', 'What to copy': 'Qué copiar', 'Everything': 'Todo', 'Copying…': 'Copiando…',
  'Username to add': 'Usuario a añadir', 'Token name, e.g. “Claude Desktop”': 'Nombre del token, p. ej. “Claude Desktop”',
  'Toggle file panel': 'Mostrar/ocultar archivos', 'Toggle side panel': 'Mostrar/ocultar panel lateral', 'Graph settings': 'Ajustes del grafo', 'Settings': 'Ajustes', 'Drag to resize': 'Arrastra para cambiar el tamaño',
  'Style': 'Estilo', 'Constellation': 'Constelación', 'Classic': 'Clásico',
  'Map': 'Mapa', 'Document': 'Documento', 'Activity': 'Actividad', 'Recent activity': 'Actividad reciente', 'Online now': 'Conectados ahora', 'Only you': 'Solo tú', 'just now': 'ahora mismo',
  'edited': 'editó', 'merged changes in': 'fusionó cambios en', 'added text to': 'añadió texto a', 'deleted': 'eliminó', 'renamed': 'renombró', 'restored': 'restauró', 'uploaded': 'subió', 'created folder': 'creó la carpeta', 'deleted folder': 'eliminó la carpeta', 'moved folder': 'movió la carpeta', 'edited outside VaultFree:': 'editó fuera de VaultFree:',
  'New folder': 'Nueva carpeta', 'New subfolder': 'Nueva subcarpeta', 'Rename folder': 'Renombrar carpeta', 'Delete folder': 'Eliminar carpeta',
  'Move note to folder…': 'Mover nota a carpeta…', '(vault root)': '(raíz del vault)', 'Folder name': 'Nombre de la carpeta', 'or full path': 'o ruta completa',
  // generic modals
  'Cancel': 'Cancelar', 'OK': 'Aceptar', 'Confirm': 'Confirmar', 'Name or folder/name': 'Nombre o carpeta/nombre', 'New vault': 'Nuevo vault',
  'Delete note': 'Eliminar nota', 'Create note': 'Crear nota', 'Join vault': 'Unirse al vault', 'Join': 'Unirse',
  'Find or create a note…': 'Buscar o crear una nota…', 'Command…': 'Comando…',
};

/** Translate a short UI label. Anything without an entry (explanations, user data) stays as is. */
export function t(s) { return lang === 'es' && ES[s] ? ES[s] : s; }

/** Templates with a variable part. */
export const tf = {
  signOut: (u) => (lang === 'es' ? `Cerrar sesión (${u})` : `Sign out (${u})`),
  backlinks: (n) => (lang === 'es' ? `Retroenlaces (${n})` : `Backlinks (${n})`),
  outgoing: (n) => (lang === 'es' ? `Enlaces salientes (${n})` : `Outgoing links (${n})`),
  invitePeople: (v) => (lang === 'es' ? `Invitar a “${v}”` : `Invite people to “${v}”`),
  members: (v) => (lang === 'es' ? `Miembros — ${v}` : `Members — ${v}`),
  createNamed: (q) => (lang === 'es' ? `Crear “${q}”` : `Create “${q}”`),
  onlyFolder: (f) => (lang === 'es' ? `Solo la carpeta: ${f}` : `Only folder: ${f}`),
};

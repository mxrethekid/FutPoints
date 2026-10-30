# FUTPOINTS · servidor dedicado

La partida se ejecuta en este servidor (no en el móvil de nadie). Los jugadores solo envían sus
teclas y reciben el estado. El primero que crea la sala es el **administrador** (▶ Iniciar, ⚙, bots,
equipos); si se va, el mando pasa al siguiente.

## Probar en tu PC
    npm install
    npm start        # http://localhost:3000

## Publicar gratis en Render (región Frankfurt, la más cercana a España)
1. Sube esta carpeta a un repositorio de GitHub (puede ser privado).
2. En render.com: New → Blueprint → elige el repositorio (lee `render.yaml`). Plan Free.
3. Cuando termine, tu juego está en `https://futpoints-XXXX.onrender.com`. Ese enlace es el juego:
   todos entran por ahí y se crean/unen a salas con el código de 4 números.

## Notas
- Plan gratis de Render: se duerme tras 15 min sin tráfico y despertar tarda ~1 min (el juego avisa).
- Para cambiar el juego edita `public/index.html` y haz push: Render se redespliega solo.
  El servidor carga la simulación de los bloques marcados `/*@SIM*/ … /*@END*/` de ese archivo,
  así que no hay que mantener código duplicado. No borres esos marcadores.
- Variables opcionales: `PORT`, `MAX_ROOMS` (por defecto 20).

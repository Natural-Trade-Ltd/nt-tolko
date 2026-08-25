# Portal Tolko — Centro de Análisis NT

Portal interno de Natural Trade para procesar, analizar y guardar histórico de las **listas de venta de Tolko** (y base replicable para otros aserraderos).

**URL viva:** https://natural-trade-ltd.github.io/nt-tolko/ · Clave: `NT-Tolko-2026`

## Qué hace

1. **Ingesta** de las dos fuentes semanales de Tolko:
   - *Tolko U.S. Sales List* (correo de mill.sales@tolko.com con link a un .xlsx de ~10 pestañas) → se sube el archivo en la vista **Cargar** (el parseo corre en el navegador, mismo `parser.js`).
   - *Tolko Low Grade* (correo de Brittny Wilson con tabla HTML #3/ECON **con US MILL y CDN MILL**) → se pega la tabla copiada de Gmail en **Cargar**.
2. **Costeo automático**: `costo puesto en frontera = US MILL × (1 − descuento) + flete` (descuento vigente 25%, aplica a toda la lista USD; fletes por grupo de mills, editables). Donde Tolko no publica US MILL (studs, dimension, MSR, A&J) se recupera de la lista CDN (`CDN MILL ÷ factor`, exacto) y, si tampoco hay CDN, se estima `US MILL ≈ Chicago − spread` y se marca **≈**. La lista CDN es precio **neto** (ya contempla el trato): esa vía se compara sin descuento, `CDN MILL ÷ FX del día`.
3. **Análisis**: carros completos vs lotes por armar (volumen `1` = carro, `41M` = 41 MBF), tallys, status Prompt/semana, ranking de oportunidades vs mediana del grupo.
4. **Selección → WhatsApp**: seleccionas carros y copias la lista en el formato oficial:
   `Carro#1: SPF 2x4 #3 42/8' 24/10' (Prompt) $390/MPT El Paso`
5. **Históricos**: cada lista queda guardada; gráfica de evolución US MILL / Chicago por mill.

## Arquitectura

```
Correo Tolko ──▶ Cargar (xlsx upload / pegar tabla) ──▶ parser.js (navegador)
                                                            │  items normalizados
                                                            ▼
                      Supabase «Matriz de Ofertas» (borouviqngtdzfvlmlur)
                      Edge Function tolko-api  (clave + service role, RLS cerrado)
                      Tablas: tolko_listas · tolko_items · tolko_fletes · tolko_params
                                                            │
                                                            ▼
                                  Portal (GitHub Pages, este repo, Dueto Tierra)
```

- **RLS cerrado** en las 4 tablas; todo pasa por `tolko-api` con la clave.
- El frontend manda `Content-Type: text/plain` (evita preflight CORS desde GitHub Pages).
- Mismo proyecto Supabase que la **matriz de ofertas** → integración directa futura (mandar selección a la matriz).

## Fuentes y formatos (lo aprendido del archivo)

| Pestaña | Formato | Precio |
|---|---|---|
| IN_OUT Schedule | glosario de mills (no se ingesta) | — |
| 4"/6" STUD, 2x3 STUDS & SHORTS | trim (92-5/8"…) × mill × unidades por semana; `pkg/CB` = paquetes por carro | solo $CHI |
| SPF DIMENSION | tally 8–20' en paquetes, secciones por medida/grado | solo $CHI |
| FIR | igual + columna Species | **$CHI y $USMILL** |
| #3 & ECON | mill, medida-grado, pcs/pkg, Volume (`1`=carro, `NNM`=MBF), tally, status | solo $CHI |
| MSR | tally con grado 1650/2100/2700 | solo $CHI |
| A & J GRADE | un largo por fila × columnas de semana | solo $CHI |
| **Correo Low Grade** | mismo formato #3 & ECON | **CHI + US MILL + CDN MILL** ← fuente real del costo |

- Mills: HVT (High Level AB) · LVT/AL (Armstrong-Lavington BC) · LD/SC/QUT (Lakeview-Quesnel BC) · KLT (Kelowna).
- Fletes sembrados (USD/MBF): El Paso 146 (LVT/LD) / 158 (HVT) · Calexico 127 (LVT/LD) / 154 (HVT). AL, SC y QUT heredan el flete de su grupo. Agregar destinos en Configuración.
- Rojo en las listas de Tolko = Prompt (status ya lo captura).
- Carro ≈ 113 MBF (Tolko arma consistente a ese volumen en dimension).

## Ingesta por línea de comando (opcional)

```bash
npm install
node ingest/ingest-local.mjs excel "C:\Users\Jorge\Downloads\Tolko_Sales_August_18th_2026_US.xlsx"
node ingest/ingest-local.mjs lowgrade ingest/lowgrade-2026-08-18.json
```

## Replicar para otro aserradero

`parser.js` aísla TODO el conocimiento del formato. Para otro proveedor:
1. Duplicar tablas con otro prefijo o agregar columna `proveedor` (decisión al llegar el 2º caso).
2. Escribir un `parseXxx()` nuevo por formato (PDF → extraer con visión/Claude primero a JSON).
3. El costeo, portal, históricos y selección WhatsApp son genéricos (fletes/params por proveedor).

## Integración con la Matriz de Ofertas (18-ago-2026)

Botón **«Inyectar a matriz de ofertas»** en la vista Selección: inserta las ofertas seleccionadas en
`ofertas_proveedor` (proyecto NT-GF Comercializacion `nlbydvntjbevbhghtdcx`) vía la acción
`enviar_matriz` de `tolko-api`, reusando los secrets `OFERTAS_URL`/`OFERTAS_SERVICE_KEY` que ya
tenía el proyecto (los usa `publicar-ofertas`). Mapeo: FOB neto USD (trato aplicado, según modo) →
`precio_cotizado`; costo a frontera → `costo_frontera_usd` + `ciudad_frontera`; carro/lote →
`es_carga_completa`/`mpt_carro`; `canal_origen='portal-tolko'` y `mensaje_uid='portal-tolko:{item_id}'`
(re-enviar REEMPLAZA, no duplica). El chip «EN MATRIZ» marca el item (clic = retirar,
acción `quitar_matriz`). OJO: una vez en la matriz, si la dim|grade está en la canasta de un cliente
piloto y el trader la tiene en `ofertar`, `publicar-ofertas` puede llevarla a la app — ese es el flujo.

## Verificación del costeo (25-ago-2026)

**Regla confirmada por Jorge (25-ago-2026):** el 25 % se aplica a **todo lo que está en USD**;
lo que está en **CAD ya lo contempla** (la lista CDN es precio neto, se paga tal cual ÷ FX del
día, sin descuento encima). Es exactamente lo que hace `netoMillUsd()`:

```
vía USD = US MILL de lista × 0.75      ← si Tolko no publica US MILL: (CDN MILL ÷ factor) × 0.75
vía CAD = CDN MILL ÷ FX del día        ← sin descuento, ya viene neta
costo frontera = min(vía USD, vía CAD) + flete      (modo «el mejor de ambos»)
```

Contrastando la lista CDN contra el correo Low Grade del 18-ago (única fuente con **US MILL
publicado** renglón a renglón), la derivación `US MILL = CDN MILL ÷ factor` da el número
**exacto**: 450.0, 299.0, 294.0, 289.0, 284.0 — idénticos a los del correo. O sea que en los
264 renglones donde Tolko no publica US MILL, el bruto sobre el que corre el 25 % se reconstruye
bien. La aritmética (descuento + flete + margen) está bien; lo que hay que cuidar es qué
producto es cada renglón.

- **CDN MILL = US MILL × constante** (1.13253 en la lista del 25-ago, 1.134409 en la del 18-ago),
  exacta a 5 decimales en todos los renglones: es la tasa interna de Tolko, no un precio de
  mercado canadiense. Por eso la lista CDN no aporta precio nuevo, solo un US MILL más limpio.
- **La vía «CDN ÷ FX del día» nunca gana** mientras el descuento sea ≥ 18.2 %: con 25 % haría
  falta un USDCAD de 1.5125 (hoy 1.38). Dicho de otro modo, que la lista CDN «ya contemple» el
  25 % implica una tasa interna de Tolko de ~1.51; contra el mercado a 1.38 la vía CAD sale
  cara. El modo «el mejor de ambos» hoy siempre resuelve por la vía USD — correcto, pero no es
  palanca real hasta que el FX se acerque a 1.51.
- **Shorts**: las pestañas de studs/shorts traen el largo en el *trim* (84", 72", 60", 6'), no en
  pies. Un `2x4 #2` de 84" cuesta ~$90/MPT menos que uno de largo normal y salía en pantalla como
  un `2x4 #2` cualquiera — por eso aparecían #2 más baratos que #3. Ahora el largo va en el nombre
  del producto (pantalla, WhatsApp y matriz), con chip **SHORTS** y filtro «Sin shorts».

## Pendientes

- [ ] Ingesta 100% automática del correo (tarea programada que lee Gmail, baja el xlsx del link Mailchimp y postea a `tolko-api` — requiere OK de Jorge).
- [ ] Flete grupo Kelowna (KLT) y mills sueltos (LULU, COL) — hoy sin costo («costo pendiente»).

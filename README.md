# Portal Tolko — Centro de Análisis NT

Portal interno de Natural Trade para procesar, analizar y guardar histórico de las **listas de venta de Tolko** (y base replicable para otros aserraderos).

**URL viva:** https://natural-trade-ltd.github.io/nt-tolko/ · Clave: `NT-Tolko-2026`

## Qué hace

1. **Ingesta** de las dos fuentes semanales de Tolko:
   - *Tolko U.S. Sales List* (correo de mill.sales@tolko.com con link a un .xlsx de ~10 pestañas) → se sube el archivo en la vista **Cargar** (el parseo corre en el navegador, mismo `parser.js`).
   - *Tolko Low Grade* (correo de Brittny Wilson con tabla HTML #3/ECON **con US MILL y CDN MILL**) → se pega la tabla copiada de Gmail en **Cargar**.
2. **Costeo automático**: `costo puesto en frontera = US MILL × (1 − descuento) + flete` (descuento vigente 25%; fletes por grupo de mills, editables). Donde Tolko no publica US MILL (studs, dimension, MSR, A&J) se estima `US MILL ≈ Chicago − spread` y se marca **≈**.
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

## Pendientes

- [ ] Ingesta 100% automática del correo (tarea programada que lee Gmail, baja el xlsx del link Mailchimp y postea a `tolko-api` — requiere OK de Jorge).
- [ ] Confirmar: ¿el 25% aplica también fuera de low grade? ¿Tolko publica US MILL de studs/dimension al pedirlo?
- [ ] Flete grupo Kelowna (KLT) y mills sueltos (COL) — hoy sin costo.
- [ ] Botón «mandar selección a la matriz de ofertas».

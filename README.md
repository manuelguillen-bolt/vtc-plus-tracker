# VTC Plus · Fleet Agreement Tracker

Dashboard estático (GitHub Pages) del fleet agreement con VTC Plus, reconstruido cada mañana con los datos al día vencido.

Es la misma lógica de datos y de cálculo que el artifact de claude.ai (`fleet-template.html`). `build.js` ejecuta
las SQL y `compute()` de esa plantilla contra Databricks e incrusta el resultado en `docs/index.html`.
Del repo de Ottocabs solo se ha copiado la infraestructura: build diario, espera al dato de ayer y publicación en Pages.

## Cómo funciona

```
fleet-template.html            página + SQL + cálculos (única fuente de la lógica)
build.js                       Sheet de companies + Databricks -> docs/index.html
docs/index.html                resultado publicado (GitHub Pages: branch main, carpeta /docs)
data/closed/AAAA-MM.json       cifras de cada mes cerrado, congeladas (no se sobrescriben)
.github/workflows/update-dashboard.yml   cron diario con espera al dato de ayer
```

- **Mes en curso:** datos hasta ayer (hora de Madrid), con proyección de viajes y nivel de kickback.
- **Mes cerrado:** el día 3 del mes siguiente `build.js` congela lista de companies y cifras en `data/closed/` y ya no
  vuelve a consultarlo. Los datos de octubre dejaron de cambiar el 2 de noviembre. Antes del día 3 el mes se calcula en vivo.
- **Companies:** salen del Google Sheet (pestaña "Cohorts by Grouping", Fleet Owner = VTC Plus). El build aborta si el
  Sheet parece incorrecto (menos de 20 companies o faltan IDs de control).
- **Sin cambios, sin commit:** si los datos no cambian, la hora de actualización no cambia y no se hace commit.
- **Fallo:** si el workflow falla se abre (o se comenta) un issue con la etiqueta `build-failure`.

## Puesta en marcha

1. Crear el repo en GitHub y subir esta carpeta.
2. **Settings → Pages**: Source = `Deploy from a branch`, branch `main`, carpeta `/docs`.
3. **Settings → Secrets and variables → Actions**, añadir:
   - `DATABRICKS_HOST` (por ejemplo `https://xxx.cloud.databricks.com`)
   - `DATABRICKS_TOKEN` (mejor un token de service principal con permiso de solo lectura)
   - `DATABRICKS_WAREHOUSE_ID`
   - `SHEET_CSV_URL`: en el Sheet, **Archivo → Compartir → Publicar en la web**, elegir la pestaña
     "Cohorts by Grouping", formato CSV, y copiar el enlace.
4. **Actions → Actualizar dashboard VTC Plus → Run workflow** para la primera carga.

Prueba local sin red (solo meses congelados): `node build.js --offline`.
Prueba local completa: exportar las cuatro variables de entorno y ejecutar `node build.js`.

## Privacidad

Con Pages público, cualquiera con el enlace ve ingresos, branding, fleet bonus, supply spend y los tramos del kickback.
El enlace del Sheet publicado expone esa pestaña a quien lo tenga: guárdalo solo como secret.
Nunca subas tokens al repo.

## Cambiar la lógica

Todo cambio de cálculo, SQL o diseño se hace en `fleet-template.html`. Los meses congelados conservan las cifras con
las que se calcularon: si cambias una definición y quieres aplicarla a un mes cerrado, borra su archivo de `data/closed/`
y el build lo recalculará y volverá a congelar.

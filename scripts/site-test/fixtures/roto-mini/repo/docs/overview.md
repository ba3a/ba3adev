# Overview

The palette of a project is a `ProjectPalette`. It holds a `RampSet`, and the
qualified name `com.roto.core.palette.RampSet` finds the same type.

Explicit links work too: see [the ramp set](ref:RampSet) and
[the palette loader](ref:com.roto.core.palette.ProjectPalette.Companion.load).

A name the reference does not have, such as `Nothing`, is left as plain code.

```kotlin
val palette: ProjectPalette = ProjectPalette.load(project)
```

Back to the [pipeline](pipeline.md).

// Gradle init script that makes Dokka produce the API reference of roto-core
// without changing the sources of the roto repository.
//
// It is passed to the build with --init-script (see the docs block of
// content/ba3a.dev/projects/roto/project.yaml). It
//
//   1. puts the Dokka 2 Gradle plugin on the classpath of the build, pinned to a
//      version that works with Kotlin 2.3;
//   2. makes sure the plugin is applied to the project ":roto-core" and to no
//      other project. A project that applies Dokka itself (roto does, through
//      its convention plugin in buildSrc) is left to do so, because applying the
//      plugin a second time from another class loader fails the build; the
//      script then only configures the extension that is there;
//   3. reports every public declaration without KDoc (reportUndocumented) and
//      leaves inherited members out of the pages (suppressInheritedMembers), so
//      that a type lists what it declares itself.
//
// The undocumented declarations are written to the build log as lines like
// "Undocumented: com.roto.core.Foo, ..."; coffer lists them in its build report.
// They are warnings: they never fail the build.
//
// The extension is configured through reflection, because the Dokka classes that
// the project loaded from buildSrc are not the ones this script has on its own
// class path.

import org.gradle.api.Action
import org.gradle.api.NamedDomainObjectContainer
import org.gradle.api.provider.Property
import org.jetbrains.dokka.gradle.DokkaPlugin

initscript {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
    dependencies {
        // Keep this version in step with the Kotlin version of the roto repository
        // (Dokka 2.1.x supports Kotlin 2.3).
        classpath("org.jetbrains.dokka:dokka-gradle-plugin:2.1.0")
    }
}

val referencedProject = ":roto-core"
val dokkaPluginId = "org.jetbrains.dokka"

/** Sets a Gradle property (`Property<Boolean>`) that the given Dokka object has, whatever class loader the object comes from. */
fun setFlag(target: Any, getter: String, value: Boolean) {
    val method = target.javaClass.getMethod(getter)
    method.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    (method.invoke(target) as Property<Boolean>).set(value)
}

/** Calls `configureEach` on the named container of the Dokka extension. */
fun configureEach(extension: Any, getter: String, configure: (Any) -> Unit) {
    val method = extension.javaClass.getMethod(getter)
    method.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    (method.invoke(extension) as NamedDomainObjectContainer<Any>).configureEach(Action<Any> { configure(this) })
}

fun configureDokka(extension: Any) {
    configureEach(extension, "getDokkaSourceSets") { sourceSet -> setFlag(sourceSet, "getReportUndocumented", true) }
    configureEach(extension, "getDokkaPublications") { publication -> setFlag(publication, "getSuppressInheritedMembers", true) }
}

gradle.allprojects {
    if (path != referencedProject) return@allprojects
    var configured = false
    val configureOnce = {
        if (!configured) {
            configured = true
            configureDokka(extensions.getByName("dokka"))
        }
    }
    // The project applies Dokka itself: configure what it made.
    pluginManager.withPlugin(dokkaPluginId) { configureOnce() }
    // The project does not: apply the plugin from this script's class path.
    afterEvaluate {
        if (!pluginManager.hasPlugin(dokkaPluginId)) {
            pluginManager.apply(DokkaPlugin::class.java)
            configureOnce()
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace RecreateGames.Reconstruction.Editor
{
    [Serializable]
    internal sealed class OceanCompatibilityMaterialRow
    {
        public string sourceFile;
        public long sourcePathId;
        public string name;
        public long originalShaderPathId;
        public string originalShaderCanonicalName;
        public string compatShaderCanonicalName;
        public string classification;
        public string shaderKeywords;
        public int customRenderQueue;
        public bool enableInstancingVariants;
        public bool doubleSidedGI;
        public int lightmapFlags;
        public string[] disabledShaderPasses;
        public ImportReadyMaterialStringTagPlan[] stringTags;
        public ImportReadyMaterialColorPlan[] colors;
        public ImportReadyMaterialFloatPlan[] floats;
        public ImportReadyMaterialTexEnvPlan[] texEnvs;
    }

    [Serializable]
    internal sealed class OceanCompatibilityPlan
    {
        public int schemaVersion;
        public string sourceUnityVersion;
        public string classification;
        public string sourceManifest;
        public string sourceManifestSha256;
        public ImportReadyTexturePlan[] textures;
        public OceanCompatibilityMaterialRow[] materials;
        public long[] motionVectorMaterialPathIds;
        public long[] visualMaterialPathIds;
    }

    [Serializable]
    internal sealed class OceanCompatibilityReceipt
    {
        public string schema = "animalparty.full_reconstruction.ocean_compat_materialization.v1";
        public string generatedAtUtc;
        public string unityVersion;
        public string classification;
        public int exactTexturesMaterialized;
        public int decodedMaterialsMaterialized;
        public int rendererSlotsBound;
        public int motionVectorRenderersDisabled;
        public int oceanRenderersVisited;
        public int remainingNullOceanMaterialSlots;
        public bool passed;
    }

    /// <summary>
    /// Red October ocean compatibility bridge.
    /// Exact decoded Texture2D payloads and exact decoded Material saved-property state are retained.
    /// The unavailable original Recreate/Ocean shader family is NOT claimed recovered here: Standard is
    /// an explicit NON-PARITY shader compatibility substitution. Motion-vector renderers are disabled
    /// rather than rendered with a visually incorrect ordinary surface shader.
    /// </summary>
    public static class OceanCompatibilityMaterializer
    {
        public const string PlanPath = "Assets/Reconstruction/Data/OceanCompatibility.materialization.json";
        public const string RuntimeScenePath = FullReconstructionSupplementalMapSanitizer.RedOctoberRuntime;

        public static void MaterializeAndBindRuntimeScene()
        {
            string projectRoot = Directory.GetParent(Application.dataPath).FullName;
            string planAbsolute = Path.Combine(projectRoot, PlanPath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(planAbsolute)) throw new FileNotFoundException("Ocean compatibility plan missing", planAbsolute);
            OceanCompatibilityPlan plan = JsonUtility.FromJson<OceanCompatibilityPlan>(File.ReadAllText(planAbsolute));
            if (plan == null || plan.schemaVersion != 1 || plan.sourceUnityVersion != "2018.4.22f1")
                throw new InvalidDataException("Ocean compatibility plan schema/version mismatch");

            ReconstructionImportReadyAssetRegistry registry = ReconstructionImportReadyAssetFactory.EnsureAssets();
            ImportReadyTexturePlan[] textures = plan.textures ?? new ImportReadyTexturePlan[0];
            for (int i = 0; i < textures.Length; i++)
            {
                Texture2D texture = ReconstructionImportReadyAssetFactory.EnsureTexture(textures[i]);
                registry.RegisterTexture(textures[i].sourceFile, textures[i].sourcePathId, texture);
            }

            Dictionary<long, Material> materialsBySourcePathId = new Dictionary<long, Material>();
            OceanCompatibilityMaterialRow[] materialRows = plan.materials ?? new OceanCompatibilityMaterialRow[0];
            for (int i = 0; i < materialRows.Length; i++)
            {
                OceanCompatibilityMaterialRow src = materialRows[i];
                ImportReadyMaterialPlan row = new ImportReadyMaterialPlan
                {
                    sourceFile = src.sourceFile,
                    sourcePathId = src.sourcePathId,
                    name = src.name,
                    shaderCanonicalName = src.compatShaderCanonicalName,
                    shaderBindingKind = "unity_builtin_shader_find",
                    shaderKeywords = src.shaderKeywords,
                    customRenderQueue = src.customRenderQueue,
                    enableInstancingVariants = src.enableInstancingVariants,
                    doubleSidedGI = src.doubleSidedGI,
                    lightmapFlags = src.lightmapFlags,
                    disabledShaderPasses = src.disabledShaderPasses,
                    stringTags = src.stringTags,
                    colors = src.colors,
                    floats = src.floats,
                    texEnvs = src.texEnvs
                };
                Material material = ReconstructionImportReadyAssetFactory.EnsureMaterial(row, registry);
                registry.RegisterMaterial(row.sourceFile, row.sourcePathId, material);
                materialsBySourcePathId[src.sourcePathId] = material;
            }
            AssetDatabase.SaveAssets();

            Material center, centerMotion, standard, standardMotion;
            if (!materialsBySourcePathId.TryGetValue(13, out center) ||
                !materialsBySourcePathId.TryGetValue(14, out centerMotion) ||
                !materialsBySourcePathId.TryGetValue(17, out standard) ||
                !materialsBySourcePathId.TryGetValue(18, out standardMotion))
                throw new InvalidDataException("Ocean compatibility material set incomplete");

            Scene scene = EditorSceneManager.OpenScene(RuntimeScenePath, OpenSceneMode.Single);
            if (!scene.IsValid() || !scene.isLoaded) throw new InvalidDataException("Red October runtime scene failed to open");

            OceanCompatibilityReceipt receipt = new OceanCompatibilityReceipt
            {
                generatedAtUtc = DateTime.UtcNow.ToString("o"),
                unityVersion = Application.unityVersion,
                classification = plan.classification,
                exactTexturesMaterialized = textures.Length,
                decodedMaterialsMaterialized = materialRows.Length
            };

            GameObject oceanRoot = FindByName(scene.GetRootGameObjects(), "OceanSurface");
            if (oceanRoot == null) throw new InvalidDataException("OceanSurface root missing in Red October runtime scene");
            Renderer[] renderers = oceanRoot.GetComponentsInChildren<Renderer>(true);
            receipt.oceanRenderersVisited = renderers.Length;
            for (int i = 0; i < renderers.Length; i++)
            {
                Renderer renderer = renderers[i];
                if (renderer == null) continue;
                bool motion = renderer.name.IndexOf("MotionVec", StringComparison.OrdinalIgnoreCase) >= 0;
                bool centerObject = String.Equals(renderer.name, "OceanCenter", StringComparison.Ordinal) ||
                                    String.Equals(renderer.name, "OceanCenterMotionVec", StringComparison.Ordinal);
                Material desired = centerObject ? (motion ? centerMotion : center) : (motion ? standardMotion : standard);
                Material[] slots = renderer.sharedMaterials;
                if (slots == null || slots.Length == 0) slots = new Material[1];
                bool changed = false;
                for (int s = 0; s < slots.Length; s++)
                {
                    if (slots[s] != null) continue;
                    slots[s] = desired;
                    receipt.rendererSlotsBound++;
                    changed = true;
                }
                if (changed) renderer.sharedMaterials = slots;
                if (motion && renderer.enabled)
                {
                    renderer.enabled = false;
                    receipt.motionVectorRenderersDisabled++;
                }
            }

            renderers = oceanRoot.GetComponentsInChildren<Renderer>(true);
            for (int i = 0; i < renderers.Length; i++)
            {
                Material[] slots = renderers[i].sharedMaterials;
                for (int s = 0; s < slots.Length; s++) if (slots[s] == null) receipt.remainingNullOceanMaterialSlots++;
            }
            receipt.passed = receipt.exactTexturesMaterialized == 6 && receipt.decodedMaterialsMaterialized == 4 &&
                             receipt.rendererSlotsBound > 0 && receipt.remainingNullOceanMaterialSlots == 0;
            if (!receipt.passed)
                throw new InvalidDataException("Ocean compatibility materialization did not close null-material gate");

            EditorSceneManager.MarkSceneDirty(scene);
            if (!EditorSceneManager.SaveScene(scene, RuntimeScenePath, false))
                throw new IOException("Failed to save Red October runtime ocean compatibility bindings");

            string reconstructionRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "../.."));
            string output = Path.Combine(reconstructionRoot, "full_reconstruction/evidence/ocean_compatibility_materialization.json");
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            File.WriteAllText(output, JsonUtility.ToJson(receipt, true) + "\n");
            Debug.Log("FULL_RECON_OCEAN_COMPAT_OK textures=" + receipt.exactTexturesMaterialized +
                      " materials=" + receipt.decodedMaterialsMaterialized +
                      " slots=" + receipt.rendererSlotsBound +
                      " motionDisabled=" + receipt.motionVectorRenderersDisabled +
                      " remainingNull=" + receipt.remainingNullOceanMaterialSlots +
                      " classification=NON-PARITY_COMPAT");
        }

        private static GameObject FindByName(GameObject[] roots, string name)
        {
            for (int i = 0; i < roots.Length; i++)
            {
                Transform[] transforms = roots[i].GetComponentsInChildren<Transform>(true);
                for (int j = 0; j < transforms.Length; j++)
                    if (String.Equals(transforms[j].name, name, StringComparison.Ordinal)) return transforms[j].gameObject;
            }
            return null;
        }
    }
}

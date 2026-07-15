//! 内置 Agent Skill：内嵌文件定义、修改保护与启动时种子写入。

use std::fs;
use std::io;
use std::path::Path;
use walkdir::WalkDir;

use super::*;

pub(crate) struct BuiltinSkillFile {
    pub(crate) path: &'static str,
    pub(crate) content: &'static str,
}

pub(crate) struct BuiltinSkill {
    pub(crate) name: &'static str,
    pub(crate) files: &'static [BuiltinSkillFile],
}

const API2IMG_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "LICENSE.txt",
        content: include_str!("../../../prompt/skills/api2img/LICENSE.txt"),
    },
    BuiltinSkillFile {
        path: "NOTICE.txt",
        content: include_str!("../../../prompt/skills/api2img/NOTICE.txt"),
    },
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../../prompt/skills/api2img/SKILL.md"),
    },
    BuiltinSkillFile {
        path: "references/ai-adapter.md",
        content: include_str!("../../../prompt/skills/api2img/references/ai-adapter.md"),
    },
];

const HATCH_PET_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "LICENSE.txt",
        content: include_str!("../../../prompt/skills/hatch-pet/LICENSE.txt"),
    },
    BuiltinSkillFile {
        path: "NOTICE.txt",
        content: include_str!("../../../prompt/skills/hatch-pet/NOTICE.txt"),
    },
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../../prompt/skills/hatch-pet/SKILL.md"),
    },
    BuiltinSkillFile {
        path: "references/animation-rows.md",
        content: include_str!("../../../prompt/skills/hatch-pet/references/animation-rows.md"),
    },
    BuiltinSkillFile {
        path: "references/liveagent-pet-contract.md",
        content: include_str!(
            "../../../prompt/skills/hatch-pet/references/liveagent-pet-contract.md"
        ),
    },
    BuiltinSkillFile {
        path: "references/qa-rubric.md",
        content: include_str!("../../../prompt/skills/hatch-pet/references/qa-rubric.md"),
    },
    BuiltinSkillFile {
        path: "references/visual-generation.md",
        content: include_str!("../../../prompt/skills/hatch-pet/references/visual-generation.md"),
    },
    BuiltinSkillFile {
        path: "references/workflow.md",
        content: include_str!("../../../prompt/skills/hatch-pet/references/workflow.md"),
    },
];

const SKILLS_INSTALLER_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../../prompt/skills/skills-installer/SKILL.md"),
    },
    BuiltinSkillFile {
        path: "references/install-sources.md",
        content: include_str!(
            "../../../prompt/skills/skills-installer/references/install-sources.md"
        ),
    },
    BuiltinSkillFile {
        path: "references/safety-and-conflicts.md",
        content: include_str!(
            "../../../prompt/skills/skills-installer/references/safety-and-conflicts.md"
        ),
    },
];

const SKILLS_CREATOR_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../../prompt/skills/skills-creator/SKILL.md"),
    },
    BuiltinSkillFile {
        path: "references/agent-skill-format.md",
        content: include_str!(
            "../../../prompt/skills/skills-creator/references/agent-skill-format.md"
        ),
    },
    BuiltinSkillFile {
        path: "references/authoring-patterns.md",
        content: include_str!(
            "../../../prompt/skills/skills-creator/references/authoring-patterns.md"
        ),
    },
];

pub(crate) const BUILTIN_AGENT_SKILLS: &[BuiltinSkill] = &[
    BuiltinSkill {
        name: "api2img",
        files: API2IMG_FILES,
    },
    BuiltinSkill {
        name: "hatch-pet",
        files: HATCH_PET_FILES,
    },
    BuiltinSkill {
        name: "skills-installer",
        files: SKILLS_INSTALLER_FILES,
    },
    BuiltinSkill {
        name: "skills-creator",
        files: SKILLS_CREATOR_FILES,
    },
];

pub(crate) fn is_builtin_agent_skill_name(name: &str) -> bool {
    BUILTIN_AGENT_SKILLS
        .iter()
        .any(|skill| skill.name.eq_ignore_ascii_case(name))
}

pub(crate) fn ensure_not_builtin_skill_management_target(
    name: &str,
    action: &str,
) -> Result<(), String> {
    if is_builtin_agent_skill_name(name) {
        return Err(format!(
            "SkillsManager action={action} cannot modify built-in Skill \"{name}\". Built-in Skills are managed by LiveAgent; create or update a separate user Skill instead."
        ));
    }
    Ok(())
}

pub fn ensure_builtin_agent_skills_sync() -> Result<Vec<SystemBuiltinSkillSeedResponse>, String> {
    let root = skills_root_dir()?;
    ensure_builtin_agent_skills_in_root(&root)
}

pub(crate) fn builtin_skill_files_match(
    target: &Path,
    builtin: &BuiltinSkill,
) -> Result<bool, String> {
    let mut actual_files = Vec::new();
    for entry in WalkDir::new(target).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| format!("Failed to inspect built-in Skill: {e}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(target)
            .map_err(|e| format!("Failed to compute built-in Skill path: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        actual_files.push(rel);
    }
    actual_files.sort();

    let mut expected_files = builtin
        .files
        .iter()
        .map(|file| {
            sanitize_skill_child_rel_path(file.path)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    expected_files.sort();
    if actual_files != expected_files {
        return Ok(false);
    }

    for file in builtin.files {
        let rel = sanitize_skill_child_rel_path(file.path)?;
        let path = target.join(rel);
        match fs::read_to_string(&path) {
            Ok(content) if content == file.content => {}
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to read built-in Skill file {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(true)
}

pub(crate) fn ensure_builtin_agent_skills_in_root(
    root: &Path,
) -> Result<Vec<SystemBuiltinSkillSeedResponse>, String> {
    // Seeding backs up and rewrites live skill directories in place, so it
    // must be serialized with every other skills-root writer.
    let _guard = skills_write_guard();
    fs::create_dir_all(root).map_err(|e| format!("Failed to create Skills root directory: {e}"))?;
    let mut results = Vec::new();
    for builtin in BUILTIN_AGENT_SKILLS {
        let name = sanitize_skill_name(builtin.name)?;
        let target = root.join(&name);
        let mut backup = None;
        let mut write_action = "created";

        if target.exists() {
            let validation = validate_skill_dir(&target);
            let valid_same_name = validation.ok
                && validation
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.name == name)
                    .unwrap_or(false);
            if valid_same_name {
                if builtin_skill_files_match(&target, builtin)? {
                    results.push(SystemBuiltinSkillSeedResponse {
                        name,
                        target: display_path(&target),
                        action: "kept".to_string(),
                        backup: None,
                    });
                    continue;
                }
                write_action = "updated";
            } else {
                write_action = "replaced_invalid";
            }
            backup = Some(backup_existing_path(&root, &target, &name)?);
        }

        fs::create_dir_all(&target)
            .map_err(|e| format!("Failed to create built-in Skill directory: {e}"))?;
        for file in builtin.files {
            let rel = sanitize_skill_child_rel_path(file.path)?;
            let path = target.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create built-in Skill parent: {e}"))?;
            }
            fs::write(&path, file.content).map_err(|e| {
                format!(
                    "Failed to write built-in Skill file {}: {e}",
                    path.display()
                )
            })?;
        }
        let validation = validate_skill_dir(&target);
        if !validation.ok {
            return Err(format!(
                "Built-in Skill '{}' did not validate after seeding:\n{}",
                builtin.name,
                validation.errors.join("\n")
            ));
        }
        results.push(SystemBuiltinSkillSeedResponse {
            name,
            target: display_path(&target),
            action: write_action.to_string(),
            backup: backup.map(|path| display_path(&path)),
        });
    }
    Ok(results)
}

"""Prompts configuration API endpoints (Week 9)."""
import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lct_python_backend.services.prompt_manager import get_prompt_manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["prompts"])


class PromptConfigUpdate(BaseModel):
    """Request model for updating prompt configuration"""
    prompt_config: dict
    user_id: str = "anonymous"
    comment: str = ""

class PromptRestoreRequest(BaseModel):
    """Request model for restoring prompt version"""
    version_timestamp: str
    user_id: str = "anonymous"


@router.get("/api/prompts")
async def list_prompts():
    """
    List all available prompts

    Returns list of prompt names
    """
    try:
        pm = get_prompt_manager()
        prompts = pm.list_prompts()
        return {"prompts": prompts, "count": len(prompts)}
    except Exception as e:
        print(f"[ERROR] Failed to list prompts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/prompts/config")
async def get_prompts_config():
    """
    Get complete prompts configuration

    Returns full prompts.json content
    """
    try:
        pm = get_prompt_manager()
        config = pm.get_prompts_config()
        return config
    except Exception as e:
        print(f"[ERROR] Failed to get prompts config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/prompts/{prompt_name}")
async def get_prompt(prompt_name: str):
    """
    Get a specific prompt configuration

    Args:
        prompt_name: Name of the prompt

    Returns:
        Prompt configuration dict
    """
    try:
        pm = get_prompt_manager()
        prompt = pm.get_prompt(prompt_name)
        return prompt
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to get prompt: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/prompts/{prompt_name}/metadata")
async def get_prompt_metadata(prompt_name: str):
    """
    Get prompt metadata (model, temperature, etc.) without template

    Args:
        prompt_name: Name of the prompt

    Returns:
        Metadata dict
    """
    try:
        pm = get_prompt_manager()
        metadata = pm.get_prompt_metadata(prompt_name)
        return metadata
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to get prompt metadata: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/prompts/{prompt_name}")
async def update_prompt(prompt_name: str, request: PromptConfigUpdate):
    """
    Update a prompt configuration

    Args:
        prompt_name: Name of the prompt
        request: PromptConfigUpdate with prompt_config, user_id, comment

    Returns:
        Success status and version info
    """
    try:
        pm = get_prompt_manager()

        # Validate prompt config
        validation = pm.validate_prompt(request.prompt_config)
        if not validation["valid"]:
            raise HTTPException(
                status_code=400,
                detail={"message": "Invalid prompt configuration", "errors": validation["errors"]}
            )

        # Save prompt
        result = pm.save_prompt(
            prompt_name,
            request.prompt_config,
            request.user_id,
            request.comment
        )

        return result

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Failed to update prompt: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/prompts/{prompt_name}")
async def delete_prompt(prompt_name: str, user_id: str = "anonymous", comment: str = ""):
    """
    Delete a prompt

    Args:
        prompt_name: Name of the prompt to delete
        user_id: User making the deletion
        comment: Comment about the deletion

    Returns:
        Success status
    """
    try:
        pm = get_prompt_manager()
        result = pm.delete_prompt(prompt_name, user_id, comment)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to delete prompt: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/prompts/{prompt_name}/history")
async def get_prompt_history(prompt_name: str, limit: int = 10):
    """
    Get version history for a prompt

    Args:
        prompt_name: Name of the prompt
        limit: Maximum number of versions to return

    Returns:
        List of version records
    """
    try:
        pm = get_prompt_manager()
        history = pm.get_prompt_history(prompt_name, limit)
        return {"prompt_name": prompt_name, "history": history, "count": len(history)}
    except Exception as e:
        print(f"[ERROR] Failed to get prompt history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/prompts/{prompt_name}/restore")
async def restore_prompt_version(prompt_name: str, request: PromptRestoreRequest):
    """
    Restore a prompt to a previous version

    Args:
        prompt_name: Name of the prompt
        request: PromptRestoreRequest with version_timestamp and user_id

    Returns:
        Success status
    """
    try:
        pm = get_prompt_manager()
        result = pm.restore_version(
            prompt_name,
            request.version_timestamp,
            request.user_id
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[ERROR] Failed to restore prompt version: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/prompts/{prompt_name}/validate")
async def validate_prompt_config(prompt_name: str, prompt_config: dict):
    """
    Validate a prompt configuration without saving

    Args:
        prompt_name: Name of the prompt (for context)
        prompt_config: Prompt configuration to validate

    Returns:
        Validation result with valid: bool and errors: List[str]
    """
    try:
        pm = get_prompt_manager()
        validation = pm.validate_prompt(prompt_config)
        return validation
    except Exception as e:
        print(f"[ERROR] Failed to validate prompt: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/prompts/reload")
async def reload_prompts():
    """
    Force reload prompts from file (hot-reload)

    Returns:
        Success status with timestamp
    """
    try:
        pm = get_prompt_manager()
        pm.reload()
        return {
            "success": True,
            "message": "Prompts reloaded successfully",
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        print(f"[ERROR] Failed to reload prompts: {e}")
        raise HTTPException(status_code=500, detail=str(e))

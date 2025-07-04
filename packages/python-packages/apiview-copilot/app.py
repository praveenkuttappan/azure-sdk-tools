from src.agent._agent import get_main_agent
from src._apiview_reviewer import _PROMPTS_FOLDER
from src._diff import create_diff_with_line_numbers
from src._utils import get_language_pretty_name

import asyncio
from enum import Enum
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from src._apiview_reviewer import ApiViewReview
import json
import logging
import os
from fastapi import FastAPI
from src.agent._api import router as agent_router
import prompty
import prompty.azure
from pydantic import BaseModel
from semantic_kernel.agents import AzureAIAgentThread
from semantic_kernel.exceptions.agent_exceptions import AgentInvokeException
import threading
import time

from src._database_manager import get_database_manager

# How long to keep completed jobs (seconds)
JOB_RETENTION_SECONDS = 1800  # 30 minutes
db_manager = get_database_manager()

app = FastAPI()
app.include_router(agent_router)

logger = logging.getLogger("uvicorn")  # Use Uvicorn's logger

supported_languages = [
    "android",
    "clang",
    "cpp",
    "dotnet",
    "golang",
    "ios",
    "java",
    "python",
    "rest",
    "typescript",
]


_PACKAGE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__)))
error_log_file = os.path.join(_PACKAGE_ROOT, "error.log")


# legacy endpoint for direct API review
@app.post("/{language}")
async def api_reviewer(language: str, request: Request):
    logger.info(f"Received request for language: {language}")
    logging.getLogger("uvicorn.error").debug(f"Request body: {await request.body()}")

    if language not in supported_languages:
        logger.warning(f"Unsupported language: {language}")
        raise HTTPException(status_code=400, detail=f"Unsupported language `{language}`")

    try:
        data = await request.json()

        target_apiview = data.get("target", None)
        base_apiview = data.get("base", None)
        outline = data.get("outline", None)
        comments = data.get("comments", None)

        if not target_apiview:
            logger.warning("No API content provided in the request")
            raise HTTPException(status_code=400, detail="No API content provided")

        logger.info(f"Processing {language} API review")

        reviewer = ApiViewReview(
            language=language, target=target_apiview, base=base_apiview, outline=outline, comments=comments
        )
        result = reviewer.run()
        reviewer.close()

        # Check if "error.log" file exists and is not empty
        if os.path.exists(error_log_file) and os.path.getsize(error_log_file) > 0:
            with open(error_log_file, "r") as f:
                error_message = f.read()
                logger.error(f"Error log contents:\n{error_message}")

        logger.info("API review completed successfully")
        return JSONResponse(content=json.loads(result.model_dump_json()))

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing request: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


class ApiReviewJobStatus(str, Enum):
    InProgress = "InProgress"
    Success = "Success"
    Error = "Error"


class ApiReviewJobRequest(BaseModel):
    language: str
    target: str
    base: str = None
    outline: str = None
    comments: list = None
    target_id: str = None


class ApiReviewJobStatusResponse(BaseModel):
    status: ApiReviewJobStatus
    comments: list = None
    details: str = None


@app.post("/api-review/start", status_code=202)
async def submit_api_review_job(job_request: ApiReviewJobRequest):
    # Validate language
    if job_request.language not in supported_languages:
        raise HTTPException(status_code=400, detail=f"Unsupported language `{job_request.language}`")

    reviewer = ApiViewReview(
        language=job_request.language,
        target=job_request.target,
        base=job_request.base,
        outline=job_request.outline,
        comments=job_request.comments,
    )
    job_id = reviewer.job_id
    db_manager.insert_job(job_id, {"status": ApiReviewJobStatus.InProgress, "finished": None})

    async def run_review_job():
        try:
            loop = asyncio.get_running_loop()
            # Run the blocking review in a thread pool executor
            result = await loop.run_in_executor(None, reviewer.run)
            reviewer.close()
            # Parse comments from result
            result_json = json.loads(result.model_dump_json())
            comments = result_json.get("comments", [])

            now = time.time()
            db_manager.upsert_job(job_id, {"status": ApiReviewJobStatus.Success, "comments": comments, "finished": now})
        except Exception as e:
            now = time.time()
            db_manager.upsert_job(job_id, {"status": ApiReviewJobStatus.Error, "details": str(e), "finished": now})

    # Schedule the job in the background
    asyncio.create_task(run_review_job())
    return {"job_id": job_id}


@app.get("/api-review/{job_id}", response_model=ApiReviewJobStatusResponse)
async def get_api_review_job_status(job_id: str):
    job = db_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def cleanup_job_store():
    """Cleanup completed jobs from the Cosmos DB periodically."""
    while True:
        time.sleep(60)  # Run every 60 seconds
        db_manager.cleanup_old_jobs(JOB_RETENTION_SECONDS)


class AgentChatRequest(BaseModel):
    user_input: str
    thread_id: str = None
    messages: list = None  # Optional: for multi-turn


class AgentChatResponse(BaseModel):
    response: str
    thread_id: str
    messages: list


@app.post("/agent/chat", response_model=AgentChatResponse)
async def agent_chat_thread_endpoint(request: AgentChatRequest):
    user_input = request.user_input
    thread_id = request.thread_id
    messages = request.messages or []
    # Only append user_input if not already the last message
    if not messages or messages[-1] != user_input:
        messages.append(user_input)
    try:
        async with get_main_agent() as agent:
            # Only use thread_id if it is a valid Azure thread id (starts with 'thread')
            thread = None
            if thread_id and isinstance(thread_id, str) and thread_id.startswith("thread"):
                thread = AzureAIAgentThread(client=agent.client, thread_id=thread_id)
            else:
                thread = AzureAIAgentThread(client=agent.client)
            response = await agent.get_response(messages=messages, thread=thread)
            # Get the thread id from the thread object if available
            thread_id_out = getattr(thread, "id", None) or thread_id
        return AgentChatResponse(response=str(response), thread_id=thread_id_out, messages=messages)
    except AgentInvokeException as e:
        if "Rate limit is exceeded" in str(e):
            logger.warning(f"Rate limit exceeded: {e}")
            raise HTTPException(status_code=429, detail="Rate limit exceeded. Please wait and try again.")
        logger.error(f"AgentInvokeException: {e}")
        raise HTTPException(status_code=500, detail="Agent error: " + str(e))
    except Exception as e:
        logger.error(f"Error in /agent/chat: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


class SummarizeRequest(BaseModel):
    language: str
    target: str
    base: str = None


class SummarizeResponse(BaseModel):
    summary: str


@app.post("/api-review/summarize", response_model=SummarizeResponse)
async def summarize_api(request: SummarizeRequest):
    if request.language not in supported_languages:
        raise HTTPException(status_code=400, detail=f"Unsupported language `{request.language}`")
    try:
        if request.base:
            summary_prompt_file = "summarize_diff.prompty"
            summary_content = create_diff_with_line_numbers(old=request.base, new=request.target)
        else:
            summary_prompt_file = "summarize_api.prompty"
            summary_content = request.target

        pretty_language = get_language_pretty_name(request.language)

        prompt_path = os.path.join(_PROMPTS_FOLDER, summary_prompt_file)
        inputs = {"language": pretty_language, "content": summary_content}

        # Run prompty in a thread pool to avoid blocking
        loop = asyncio.get_running_loop()

        def run_prompt():
            return prompty.execute(prompt_path, inputs=inputs)

        summary = await loop.run_in_executor(None, run_prompt)
        if not summary:
            raise HTTPException(status_code=500, detail="Summary could not be generated.")
        return SummarizeResponse(summary=summary)
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


# Start the cleanup thread when the app starts
cleanup_thread = threading.Thread(target=cleanup_job_store, daemon=True)
cleanup_thread.start()

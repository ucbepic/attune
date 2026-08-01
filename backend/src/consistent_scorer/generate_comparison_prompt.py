from src.utils.client import invoke_llm

def generate_comparison_prompt(task, data):
    prompt = f"""Your task is to design a comparison prompt with the following format to help choose one of two inputs, A and B, based on the task description provided. You must look at the sample data to determine how to best compare each row based on the task description. 

    Task Description: {task}
    Sample Data: {data}

    Prompt Format:
    <Your comparison prompt>

    Respond with exactly one character:
    A if Input A is preferred
    B if Input B is preferred

    Do not include any explanations.

    Input A:
    {{ A }}
    Input B:
    {{ B }}

    Note: The prompt must include placeholders {{ A }} and {{ B }} where the details of items A and B will be inserted for comparison. Ensure making an explicit mention to the LLM to NEVER include any explanations and respond with exactly one character: "A" or "B".
    """

    prompt = prompt.replace("{task}", task)
    generated_prompt, _, cost = invoke_llm(
        prompt=prompt,
        temperature=0.7
    )

    return (generated_prompt, cost)
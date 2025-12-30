const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const { getEnv } = require("./envParser");

/**
 * Lists available models and selects a Gemini 2.5 family model
 * @returns {Promise<string>} - Model name to use
 */
async function selectGemini25Model() {
  try {
    const apiKey = getEnv("GOOGLE_API_KEY");
    
    // Use REST API to list available models
    const response = await axios.get(
      "https://generativelanguage.googleapis.com/v1beta/models",
      {
        headers: {
          "x-goog-api-key": apiKey
        },
        params: {
          pageSize: 100
        }
      }
    );
    
    const models = response.data.models || [];
    
    // Filter for Gemini 2.5 family models (gemini-2.5, gemini-2.0, etc.)
    const gemini25Models = models.filter(model => {
      const modelName = model.name || "";
      return (modelName.includes("gemini-2") || modelName.includes("gemini-2.5")) && 
             model.supportedGenerationMethods?.includes("generateContent");
    });
    
    if (gemini25Models.length > 0) {
      // Prefer flash-lite > flash > pro for speed and cost
      const sorted = gemini25Models.sort((a, b) => {
        const aName = a.name || "";
        const bName = b.name || "";
        // Prefer flash-lite > flash > pro
        if (aName.includes("flash-lite") && !bName.includes("flash-lite")) return -1;
        if (!aName.includes("flash-lite") && bName.includes("flash-lite")) return 1;
        if (aName.includes("flash") && !bName.includes("flash")) return -1;
        if (!aName.includes("flash") && bName.includes("flash")) return 1;
        return bName.localeCompare(aName); // Prefer newer versions
      });
      
      const selectedModel = sorted[0].name.replace("models/", "");
      return selectedModel;
    }
    
    // Fallback to gemini-1.5-flash if no 2.5 models found
    return "gemini-1.5-flash";
  } catch (error) {
    console.error("Error selecting model, using fallback:", error.message);
    return "gemini-1.5-flash";
  }
}

/**
 * Analyzes profile data using Google Gemini AI
 * @param {string} markdownContent - Profile data in markdown format
 * @returns {Promise<string>} - AI insights about the profile
 */
async function analyzeProfileContent(markdownContent) {
  try {
    const apiKey = getEnv("GOOGLE_API_KEY")
    const genAI = new GoogleGenerativeAI(apiKey);
    
    const prompt = `
You are an expert performance engineer. Please analyze this CPU profile data and provide insights:
1. What are the main performance bottlenecks?
2. Which functions or areas of code need optimization?
3. What specific recommendations would you make to improve performance?

Profile data:
${markdownContent}

Please provide a concise, actionable analysis based on this profile data.
`;
    
    // Select a Gemini 2.5 family model
    const modelName = await selectGemini25Model();
    const model = genAI.getGenerativeModel({ model: modelName });
    
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2000,
      }
    });

    const response = result.response;
    return response.text();
  } catch (error) {
    console.error("Error analyzing profile:", error);
    throw new Error(`Failed to analyze profile: ${error.message}`);
  }
}

module.exports = {
  analyzeProfileContent
};
FROM node:23-alpine3.20 as builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

RUN npm run build

FROM node:23-alpine3.20 as app

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

COPY --from=builder /app/lib ./lib

EXPOSE 3000

#CMD npm run start
CMD ["npx", "probot", "run", "lib/index.js" ]


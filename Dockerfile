FROM node:22-alpine

WORKDIR /app

# install deps first (cache)
COPY package*.json ./
RUN npm ci

# copy source
COPY . .

# build TS -> JS
RUN npm run build

ENV NODE_ENV=production
CMD ["npm", "run", "start"]